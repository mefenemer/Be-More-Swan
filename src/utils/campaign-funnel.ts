// src/utils/campaign-funnel.ts
// The Campaign Assistant's ROI funnel, as arithmetic. Spend → clicks → conversions → revenue.
//
// Pure: no db, no clock. The endpoint (netlify/functions/get-campaign-funnel.ts) supplies the
// counts; this turns them into the payload the surface renders. Same split as
// campaign-performance.ts, for the same reason — the decisions worth testing are the ones about
// what a number MEANS, and they should not need a Postgres to exercise.
//
// ── The whole point of this file is what it REFUSES to report ───────────────────────────────────
// A funnel is the easiest surface in a product to lie with, because every missing number has a
// plausible-looking zero available. This repo has paid for that lie twice already: follower counts
// rendered a figure LinkedIn never supplies, and SMART Goals shipped a progress bar wired to
// nothing. So three rules hold here, and the tests enforce them:
//
//   1. A number we CANNOT know is `null`, never 0. Zero is a measurement; null is an admission.
//      They render differently and they must never be conflated — "£0.00 per lead" reads as
//      astonishingly good, and it is what "we have no spend data" would otherwise look like.
//   2. A stage we can never fill is ABSENT, not empty. There is no impressions row, because
//      nothing in this system can observe an impression: it needs an ad network's reporting API,
//      and none is connected. An "Impressions: 0" row is a permanent accusation against a campaign
//      that is working fine.
//   3. The blind spot is reported, not absorbed. Conversions we could not tie to a click are
//      counted and shown as unattributed. A funnel that quietly reassigns its own gap is
//      confidently wrong in the direction that flatters us.

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

/** Raw counts the endpoint gathers. Every one is a COUNT or a SUM — no estimates, no model. */
export interface CampaignFunnelCounts {
    /** Campaigns in scope. 0 means "never ran one", which is not the same as "ran one, got zero". */
    campaignsTotal: number;
    /** Tracked links not archived. */
    linksActive: number;

    /** Clicks we believe came from a person. */
    clicks: number;
    /**
     * Clicks flagged as automated. Reported beside `clicks`, never inside it: mail scanners and
     * link-preview bots hit tracked links constantly, so folding them in inflates every rate in
     * the product — and dropping them silently leaves a tenant unable to explain why the ad
     * platform's click count is higher than ours.
     */
    botClicks: number;

    /** Conversions tied back to a click, by what the person became. */
    contactsAttributed: number;
    leadsAttributed: number;
    recordsAttributed: number;

    /**
     * Conversions in scope that carry NO attribution — the blind spot, measured.
     *
     * These are real sign-ups and leads the workspace got; we simply could not prove which click
     * produced them (cookie dropped by ITP, query string rewritten, converted on another device).
     */
    unattributedConversions: number;

    /** Terminal outcomes recorded against attributed subjects. */
    won: number;
    lost: number;
    /** Sum of value_gbp on the won ones. */
    valueWonGbp: number;

    /**
     * How many attributed subjects are of a type that CAN carry revenue at all.
     *
     * ⚠️ Load-bearing, not diagnostics. Revenue lives in `revenue_events`, which keys on
     * `discovered_lead_id` — so a newsletter contact attributed to a campaign has no revenue path
     * whatsoever. Without this number, `won: 0` across a funnel full of audience contacts reads as
     * "the campaign produced nothing", when the truth is "we cannot see revenue for this kind of
     * conversion". Different statement, different decision.
     */
    revenueTrackableSubjects: number;

    /** Work items the campaign commissioned (the internal budget). */
    workSpent: number;
    /**
     * Real money spent, from campaign_spend_events currency='money'.
     *
     * Always 0.00 today: paid campaigns are refused at three independent guards pending Meta,
     * LinkedIn and Google approvals we do not control. Present because the arithmetic must already
     * be correct on the day that changes — not because it is expected to be non-zero.
     */
    moneySpentGbp: number;
}

// ── Outputs ─────────────────────────────────────────────────────────────────────────────────────

export interface FunnelStage {
    key: 'spend' | 'clicks' | 'conversions' | 'won';
    label: string;
    /** null means "not knowable", and the client must render it as such — never as 0. */
    value: number | null;
    /** Pre-formatted, so the client never re-derives currency or rounding. */
    display: string;
    /** The sentence beneath the figure. Always says something true, including when empty. */
    note: string;
}

export interface CampaignFunnelPayload {
    hasData: boolean;
    scope: 'lifetime';
    stages: FunnelStage[];
    rates: {
        /** Conversions per click, 0–1. null when there are no clicks to divide by. */
        clickToConversion: number | null;
        /** Won per conversion, 0–1. null when nothing is revenue-trackable. */
        conversionToWon: number | null;
        /** £ per conversion. null while spend is 0 — NOT £0.00. */
        costPerConversion: number | null;
        /** Work items per conversion. Defined even at zero spend; this is the budget we DO spend. */
        effortPerConversion: number | null;
    };
    attribution: {
        attributed: number;
        unattributed: number;
        /** Share of conversions we could tie to a click, 0–1. null when there were none at all. */
        coverage: number | null;
        /** Plain sentence naming the gap. Rendered verbatim; the honesty claim lives here. */
        caveat: string;
    };
    /**
     * Stages deliberately NOT rendered, each with the reason. The surface shows these as a short
     * "what we cannot show you yet" line rather than as empty rows.
     */
    unavailable: { key: string; label: string; reason: string }[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** £ with no decimals above 100, two below — the format the rest of the product uses. */
export function formatGbp(amount: number): string {
    return amount >= 100 || Number.isInteger(amount)
        ? `£${Math.round(amount).toLocaleString('en-GB')}`
        : `£${amount.toFixed(2)}`;
}

/** Divide, or admit there is nothing to divide by. Never returns Infinity, NaN or a fake zero. */
export function ratio(numerator: number, denominator: number): number | null {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
    return numerator / denominator;
}

export function buildCampaignFunnel(c: CampaignFunnelCounts): CampaignFunnelPayload {
    const conversions = c.contactsAttributed + c.leadsAttributed + c.recordsAttributed;
    const totalConversions = conversions + c.unattributedConversions;

    // Rule 1. Cost per conversion is UNDEFINED at zero spend, not £0.00. The zero-spend case is
    // every campaign in the product today, so this is the default path, not an edge case.
    const costPerConversion = c.moneySpentGbp > 0 ? ratio(c.moneySpentGbp, conversions) : null;

    // ⚠️ Denominated in REVENUE-TRACKABLE subjects, not all conversions. Dividing wins by a total
    // that includes newsletter contacts — which can never produce a `won` — would report a win
    // rate that falls every time a campaign succeeds at signing people up.
    const conversionToWon = ratio(c.won, c.revenueTrackableSubjects);

    const stages: FunnelStage[] = [
        {
            key: 'spend',
            label: 'Spent',
            // Money is genuinely 0 (we know it, we did not fail to measure it), so 0 is honest here.
            value: c.moneySpentGbp,
            display: formatGbp(c.moneySpentGbp),
            note: c.moneySpentGbp > 0
                ? `${plural(c.workSpent, 'work item')} also commissioned`
                : `No ad spend — ${plural(c.workSpent, 'work item')} commissioned`,
        },
        {
            key: 'clicks',
            label: 'Clicks',
            value: c.clicks,
            display: c.clicks.toLocaleString('en-GB'),
            note: c.botClicks > 0
                ? `${plural(c.botClicks, 'automated visit')} excluded`
                : (c.linksActive > 0 ? `across ${plural(c.linksActive, 'tracked link')}` : 'No tracked links yet'),
        },
        {
            key: 'conversions',
            label: 'Conversions',
            value: conversions,
            display: conversions.toLocaleString('en-GB'),
            note: describeConversions(c) ,
        },
        {
            key: 'won',
            label: 'Revenue won',
            // Rule 1 again: with nothing revenue-trackable in the funnel we have not measured zero
            // revenue, we have measured nothing at all.
            value: c.revenueTrackableSubjects > 0 ? c.valueWonGbp : null,
            display: c.revenueTrackableSubjects > 0 ? formatGbp(c.valueWonGbp) : 'Not tracked',
            note: c.revenueTrackableSubjects > 0
                ? `${plural(c.won, 'deal')} won, ${c.lost} lost`
                : 'No conversions of a kind that carries revenue',
        },
    ];

    return {
        // A workspace that has never run a campaign has nothing to report, and a row of zeroes
        // would read as a campaign that failed rather than one never started.
        hasData: c.campaignsTotal > 0,
        scope: 'lifetime',
        stages,
        rates: {
            clickToConversion: ratio(conversions, c.clicks),
            conversionToWon,
            costPerConversion,
            effortPerConversion: ratio(c.workSpent, conversions),
        },
        attribution: {
            attributed: conversions,
            unattributed: c.unattributedConversions,
            coverage: ratio(conversions, totalConversions),
            caveat: attributionCaveat(conversions, c.unattributedConversions),
        },
        unavailable: buildUnavailable(),
    };
}

/** What the conversions were, named — "12" alone does not say whether those are readers or buyers. */
function describeConversions(c: CampaignFunnelCounts): string {
    const parts = [
        c.contactsAttributed ? plural(c.contactsAttributed, 'subscriber') : '',
        c.leadsAttributed ? plural(c.leadsAttributed, 'lead') : '',
        c.recordsAttributed ? plural(c.recordsAttributed, 'record') : '',
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'Nothing tied back to a click yet';
}

/**
 * The sentence that keeps the funnel honest.
 *
 * Rule 3. Never silently absorbed into the attributed total, and never hidden when it is large —
 * a tenant comparing our number against LinkedIn's needs to know the gap exists before they
 * conclude one of the two is broken.
 */
export function attributionCaveat(attributed: number, unattributed: number): string {
    if (unattributed === 0 && attributed === 0) return 'No conversions recorded yet.';
    if (unattributed === 0) return 'Every conversion in this period was tied back to a click.';
    if (attributed === 0) {
        return `${plural(unattributed, 'conversion')} could not be tied to a click, so none of them are counted above. Ad blockers, privacy settings and converting on a different device all break the trail.`;
    }
    return `A further ${plural(unattributed, 'conversion')} could not be tied to a click and ${unattributed === 1 ? 'is' : 'are'} not counted above. Ad blockers, privacy settings and converting on a different device all break the trail.`;
}

/**
 * Stages that exist in every competitor's funnel and cannot exist in ours yet, each with the
 * reason. Rendered as an explicit note.
 *
 * ⚠️ This list is the difference between an honest empty state and a broken-looking one. The rule
 * that produced it: an empty surface must say WHY it is empty and what would fill it.
 */
function buildUnavailable(): { key: string; label: string; reason: string }[] {
    return [
        {
            key: 'impressions',
            label: 'Impressions',
            // Not "coming soon" — this needs an ad network's reporting API, and connecting one is
            // blocked on approvals we do not control.
            reason: 'Impressions are only reported by an ad network. No ad account is connected yet.',
        },
        {
            key: 'ad_spend',
            label: 'Ad spend',
            reason: 'Paid campaigns are not available yet, so every campaign so far has spent £0 on advertising.',
        },
    ];
}

/** The shape returned when the assistant has never run a campaign. */
export function emptyCampaignFunnel(): CampaignFunnelPayload {
    return buildCampaignFunnel({
        campaignsTotal: 0, linksActive: 0,
        clicks: 0, botClicks: 0,
        contactsAttributed: 0, leadsAttributed: 0, recordsAttributed: 0,
        unattributedConversions: 0,
        won: 0, lost: 0, valueWonGbp: 0, revenueTrackableSubjects: 0,
        workSpent: 0, moneySpentGbp: 0,
    });
}
