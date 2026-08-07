// src/utils/campaign-performance.ts
// The four Overview KPI cards for the Campaign Assistant, as arithmetic.
//
// ── Why this needed writing at all ──────────────────────────────────────────────────────────────
// The dashboard registry has carried campaign KPI copy since Phase 1 — "Outcomes Delivered",
// "Effort per Outcome" and the rest — while the VALUES underneath came from
// get-assistant-performance, which reads `post_insights` scoped to the assistant's own id. The
// Campaign Assistant owns no posts (they belong to the Social Media Assistant it commissions), so
// that endpoint returned hasData:false for ever and the section rendered its "nothing to report"
// panel permanently. Four labels describing figures nothing computed. This is the same shape of
// failure as goals-steer-generation: a complete surface with no wire behind it.
//
// ── The window is the CAMPAIGN'S LIFETIME, not 30 days ──────────────────────────────────────────
// A 30-day window across a six-week flight cliff-drops at rollover, reporting a fall in performance
// that is really an artefact of the window. roi-hero-defaults-all-time cost us this once already.
// Every figure here is all-time across every campaign the assistant has run.
//
// ── What counts as an OUTCOME ───────────────────────────────────────────────────────────────────
// Only things that actually exist in the world: an article or post that PUBLISHED, and a lead that
// was actually found. Not drafts, not scheduled work, not impressions. The registry copy promises
// "not clicks, not impressions" and this is what makes that true. Work still sitting in someone's
// review queue is deliberately absent — it is counted in "Needs You" instead, which is the honest
// place for it.
//
// Pure: no db, no clock. The endpoint supplies counts, this turns them into the card payload.

/** Raw counts the endpoint gathers. Every one is a COUNT — no estimates, no model. */
export interface CampaignPerformanceCounts {
    /** Campaigns this assistant has ever run, in any state. */
    campaignsTotal: number;
    campaignsLive: number;
    campaignsFinished: number;
    /** Posts commissioned by a campaign order that reached 'published'. */
    postsPublished: number;
    /** Articles commissioned by a campaign order that reached 'published'. */
    articlesPublished: number;
    /** Leads found by a saved search a campaign order created. */
    leadsFound: number;
    /** Sum of the work ledger. Signed, so refunds for failed orders are already netted off. */
    workSpent: number;
    /** Decisions the assistant raised from its own monitoring, all statuses. */
    decisionsRaised: number;
    /** …of which the user approved. */
    decisionsApproved: number;
    /** Pending, unexpired decisions waiting on the user. */
    decisionsPending: number;
    /** Orders whose work is drafted and sitting in someone's review queue. */
    ordersInReview: number;
}

export interface CampaignPerformancePayload {
    /** False when this assistant has never run a campaign — the section explains itself instead. */
    hasData: boolean;
    /** Names the window in the UI. Always lifetime; present so the client never guesses. */
    scope: 'lifetime';
    campaigns: { total: number; live: number; finished: number };
    metrics: {
        outcomes: number;
        /** Work items per outcome, or null when there are no outcomes yet to divide by. */
        effortPerOutcome: number | null;
        workSpent: number;
        decisionsRaised: number;
        needsYou: number;
    };
    /** The sentence under each card. Built here so the client never re-derives the arithmetic. */
    trends: { outcomes: string; effort: string; decisions: string; needsYou: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Join non-empty parts with a middle dot, the separator the other cards already use. */
function joinParts(parts: string[]): string {
    return parts.filter(Boolean).join(' · ');
}

export function buildCampaignPerformance(c: CampaignPerformanceCounts): CampaignPerformancePayload {
    const outcomes = c.postsPublished + c.articlesPublished + c.leadsFound;

    // Divide only when there is something to divide by. A campaign that has spent 12 work items and
    // produced nothing yet has an UNDEFINED cost per outcome, not an infinite one and certainly not
    // zero — "£0 per result" was exactly the lie the registry comment warns about for the money
    // variant of this card.
    const effortPerOutcome = outcomes > 0 ? Math.round((c.workSpent / outcomes) * 10) / 10 : null;

    const needsYou = c.decisionsPending + c.ordersInReview;

    return {
        // A workspace with no campaigns has nothing to report, and four zeroes would read as a
        // failed campaign rather than as one never started.
        hasData: c.campaignsTotal > 0,
        scope: 'lifetime',
        campaigns: { total: c.campaignsTotal, live: c.campaignsLive, finished: c.campaignsFinished },
        metrics: {
            outcomes,
            effortPerOutcome,
            workSpent: c.workSpent,
            decisionsRaised: c.decisionsRaised,
            needsYou,
        },
        trends: {
            // Name the components, because "7" on its own does not tell the user whether their
            // campaign is producing content or finding customers.
            outcomes: joinParts([
                c.postsPublished ? plural(c.postsPublished, 'post') : '',
                c.articlesPublished ? plural(c.articlesPublished, 'article') : '',
                c.leadsFound ? plural(c.leadsFound, 'lead') : '',
            ]) || 'Nothing published yet',
            effort: `${plural(c.workSpent, 'task')} spent`,
            decisions: c.decisionsRaised
                ? `${c.decisionsApproved} of ${c.decisionsRaised} approved`
                : 'Nothing raised yet',
            needsYou: needsYou
                ? joinParts([
                    c.decisionsPending ? plural(c.decisionsPending, 'decision') : '',
                    c.ordersInReview ? `${plural(c.ordersInReview, 'order')} in review` : '',
                ])
                : 'Nothing waiting',
        },
    };
}

/** The shape returned when the assistant has never run a campaign. */
export function emptyCampaignPerformance(): CampaignPerformancePayload {
    return buildCampaignPerformance({
        campaignsTotal: 0, campaignsLive: 0, campaignsFinished: 0,
        postsPublished: 0, articlesPublished: 0, leadsFound: 0,
        workSpent: 0, decisionsRaised: 0, decisionsApproved: 0,
        decisionsPending: 0, ordersInReview: 0,
    });
}
