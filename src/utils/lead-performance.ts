// src/utils/lead-performance.ts
// The four Performance Metrics cards for the Lead Generation Assistant, as arithmetic.
//
// ── Why this needed writing at all ──────────────────────────────────────────────────────────────
// The card grid on assistant-detail.html has ONE data source for every role except Campaign:
// get-assistant-performance, which reads `post_insights` — social engagement, reach, CTR, saves.
// The Lead Generation Assistant publishes nothing, so that endpoint returned hasData:false for
// ever and the section rendered:
//
//     "Performance metrics aren't available yet … once there's published activity for this
//      assistant to measure … Nothing has been published in the last 30 days."
//
// which is a sentence about a Social Media Assistant, shown under a Lead Generator, permanently.
// The registry's own KPI copy for this role ("Pipeline Volume", "Hours Reclaimed") was equally
// disconnected — four labels above figures nothing computed. Same shape of failure as
// campaign-performance.ts, and fixed the same way: its own source, routed by `metricsSource`.
//
// ── The four metrics, and why these four ────────────────────────────────────────────────────────
// The brief was "key industry standard metrics for how well the assistant is performing at lead
// generation primarily, but also at lead conversion". A lead-gen funnel has four questions, and
// each card answers exactly one:
//
//   1. VOLUME       Qualified Leads   — how many leads did it produce that you judged worth having?
//   2. ACCURACY     Qualification Rate— of the ones you ruled on, what share survived? This is the
//                                       standard MQL-rate figure, and it measures TARGETING.
//   3. ENGAGEMENT   Reply Rate        — of the ones emailed, how many wrote back? The standard
//                                       cold-outreach benchmark, and the first real conversion step.
//   4. CONVERSION   Deals Won         — closed-won count and value, plus the won-per-contacted rate.
//
// Deliberately NOT here: "Hours Reclaimed" (an estimate dressed as a measurement — nothing in the
// platform times a human doing this work by hand), and any cost-per-lead figure (the task ledger
// counts tasks, not money, and putting a £ on a card beside a real £ of closed revenue would
// invite the two to be compared).
//
// ── Why the denominators are DECIDED leads, not discovered ones ─────────────────────────────────
// Qualification rate over *discovered* leads falls every time the user gets behind on their review
// queue — the number would report the size of a backlog as a failure of targeting. Over DECIDED
// leads (approved + rejected) it moves only when the user's verdicts move, which is the thing it
// claims to measure. Same rule for reply rate: the denominator is leads actually EMAILED, never
// leads found.
//
// ── The window ──────────────────────────────────────────────────────────────────────────────────
// 90 days, not the 30 the social cards use. A B2B cold-outreach cycle runs weeks to months, so a
// 30-day window reports zero closed deals for a pipeline that is working perfectly well — the same
// window artefact that made campaign-performance go all-time (roi-hero-defaults-all-time). 90 days
// is long enough to contain a normal cycle and short enough to still describe the CURRENT search.
// The client prints whatever this returns; it never hardcodes a period.
//
// Pure: no db, no clock. The endpoint supplies counts, this turns them into the card payload.

/** The trailing window every figure below is computed over. See the header. */
export const LEAD_PERFORMANCE_DAYS = 90;

/**
 * Raw counts the endpoint gathers from the revenue ledger. Every one is a COUNT of DISTINCT LEADS
 * unless its name says otherwise — a lead emailed four times is one lead in `contacted`, or the
 * reply rate would fall every time a follow-up went out.
 */
export interface LeadPerformanceCounts {
    /** Leads a discovery run surfaced in the window (`lead_discovered`). */
    discovered: number;
    /** Leads the user approved (`lead_approved`). */
    approved: number;
    /** Leads the user turned down (`lead_rejected`) — including through Delete, which is a rejection. */
    rejected: number;
    /** Distinct leads that were actually emailed (`outreach_sent`). */
    contacted: number;
    /** Distinct leads that wrote back (`reply_received`). */
    replied: number;
    /** Distinct leads that asked us to stop (`opt_out_received`). */
    optedOut: number;
    /** Terminal outcomes in the window. */
    won: number;
    lost: number;
    disqualified: number;
    /** Sum of `value_gbp` on won deals. Null when no won deal carried a value. */
    wonValueGbp: number | null;
}

export interface LeadPerformancePayload {
    /** False when nothing has happened in the window — the section explains itself instead. */
    hasData: boolean;
    /** Names the window in the UI, so the client never guesses it. */
    periodDays: number;
    counts: LeadPerformanceCounts;
    metrics: {
        /** Card 1 — volume. */
        qualifiedLeads: number;
        /** Card 2 — 0..1, or null when nothing has been ruled on yet. */
        qualificationRate: number | null;
        /** Card 3 — 0..1, or null when nothing has been emailed yet. */
        replyRate: number | null;
        /** Card 4 — 0..1 won per lead contacted, or null when nothing has been emailed yet. */
        conversionRate: number | null;
        /** Card 4's headline value. Null when no won deal carried a figure. */
        wonValueGbp: number | null;
        /**
         * Leads that asked to stop, over leads emailed. Not a card of its own — it rides card 3's
         * trend line, because a reply rate is read very differently next to a rising opt-out rate.
         */
        optOutRate: number | null;
    };
    /** The sentence under each card's figure. Computed here so the copy cannot drift from the maths. */
    trends: {
        qualifiedLeads: string;
        qualificationRate: string;
        replyRate: string;
        conversion: string;
    };
}

/** n/d as a 0..1 fraction, or null when the denominator is zero. Never NaN, never Infinity. */
function rate(n: number, d: number): number | null {
    return d > 0 ? n / d : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The payload for an assistant with no lead activity at all in the window. */
export function emptyLeadPerformance(): LeadPerformancePayload {
    return buildLeadPerformance({
        discovered: 0, approved: 0, rejected: 0, contacted: 0, replied: 0, optedOut: 0,
        won: 0, lost: 0, disqualified: 0, wonValueGbp: null,
    });
}

export function buildLeadPerformance(c: LeadPerformanceCounts): LeadPerformancePayload {
    const decided = c.approved + c.rejected;
    const closed = c.won + c.lost + c.disqualified;

    // ⚠️ `hasData` asks whether anything HAPPENED, not whether every figure is non-zero. An
    // assistant that found 40 leads and had them all rejected has a real and quite interesting
    // 0% qualification rate; showing it the "nothing to report" panel would hide the one number
    // that explains what went wrong.
    const hasData = c.discovered > 0 || decided > 0 || c.contacted > 0 || closed > 0;

    const qualificationRate = rate(c.approved, decided);
    const replyRate = rate(c.replied, c.contacted);
    const conversionRate = rate(c.won, c.contacted);
    const optOutRate = rate(c.optedOut, c.contacted);

    return {
        hasData,
        periodDays: LEAD_PERFORMANCE_DAYS,
        counts: c,
        metrics: {
            qualifiedLeads: c.approved,
            qualificationRate,
            replyRate,
            conversionRate,
            wonValueGbp: c.wonValueGbp,
            optOutRate,
        },
        trends: {
            // Volume against what it had to sift to get there — the pair is the story, and the
            // bare count alone reads as either impressive or dismal depending on nothing.
            qualifiedLeads: c.discovered
                ? `${plural(c.discovered, 'lead', 'leads')} found`
                : (c.approved ? 'added by hand' : '—'),
            qualificationRate: decided
                ? `${plural(decided, 'lead', 'leads')} reviewed`
                : 'nothing reviewed yet',
            // The opt-out rate rides here rather than taking a card: it is meaningless alone and
            // essential beside the reply rate.
            replyRate: c.contacted
                ? `${plural(c.replied, 'reply', 'replies')} from ${plural(c.contacted, 'lead', 'leads')} emailed`
                    + (c.optedOut ? ` · ${c.optedOut} asked to stop` : '')
                : 'nothing emailed yet',
            conversion: closed
                ? `${c.won} won · ${c.lost + c.disqualified} lost`
                : (c.contacted ? 'no deals closed yet' : 'nothing emailed yet'),
        },
    };
}
