// src/utils/blog-performance.ts
// The arithmetic behind the four assistant-detail "Performance Metrics" KPI cards for the Blog
// Writer. Pure — no I/O — so the presentation rules below are locked by tests rather than by
// squinting at a live page. netlify/functions/get-blog-performance.ts supplies the counts.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// The Blog Writer's four cards were fed by get-assistant-performance.ts, which reads `post_insights`
// — the INSTAGRAM per-post insights table. A Blog Writer never writes a row there, so `hasData` was
// false for ever and the grid showed a permanent "nothing published in the last 30 days" panel.
// Worse, the registry painted Blog Writer labels (Publishing Consistency, Search Visibility, Hours
// Reclaimed, Needs You) over cards whose renderer filled engagement rate, reach growth, CTR and
// meaningful engagement — so the labels and the fields underneath them described different things.
//
// Same reasoning as get-lead-performance.ts and get-campaign-performance.ts: a role that does not
// publish social posts needs its own source, not a kinder empty state over the wrong one.
//
// ── What each card actually measures ────────────────────────────────────────────────────────────
//   1 Posts Published    — blog_posts published inside the window, with the prior window as trend.
//   2 Search Impressions — summed from blog_posts.traffic_baseline (Google Search Console).
//   3 Hours Reclaimed    — from src/utils/roi-activity.ts, the ONE module all four ROI surfaces
//                          count through. Never re-derive hours here.
//   4 Awaiting Approval  — a LIVE count, deliberately not windowed. "3 drafts waiting" is only
//                          useful as a fact about right now; "3 drafts waited during March" is not
//                          something anyone can act on.

/** The reporting window. Longer than the social 30 days: blogs publish weekly at best, and a
 *  30-day window on a fortnightly cadence reports 2 and calls a normal month a collapse. */
export const BLOG_PERFORMANCE_DAYS = 90;

export interface BlogPerformanceCounts {
    /** Posts published inside the window. */
    publishedCurrent: number;
    /** Posts published in the window before it — the growth baseline. */
    publishedPrior: number;
    /** Drafts sitting in review right now. Not windowed. */
    awaitingApproval: number;
    /**
     * Summed search impressions across posts we have a figure for, or null when Google Search
     * Console is not connected. ⚠️ null and 0 are different answers and must stay so: null is
     * "we cannot see this", 0 is "we looked and nobody found you".
     */
    searchImpressions: number | null;
    /** How many published posts contributed to searchImpressions — the honesty qualifier for it. */
    trackedPosts: number;
    /** Hours saved in the window, from roi-activity.ts. */
    hoursSaved: number;
}

export interface BlogPerformancePayload {
    hasData: boolean;
    periodDays: number;
    metrics: {
        postsPublished: number;
        publishedGrowth: number | null;
        searchImpressions: number | null;
        hoursSaved: number;
        awaitingApproval: number;
    };
    trends: {
        postsPublished: string;
        searchImpressions: string;
        hoursSaved: string;
        awaitingApproval: string;
    };
    counts: BlogPerformanceCounts;
}

export function emptyBlogPerformance(days = BLOG_PERFORMANCE_DAYS): BlogPerformancePayload {
    return {
        hasData: false,
        periodDays: days,
        metrics: {
            postsPublished: 0, publishedGrowth: null, searchImpressions: null,
            hoursSaved: 0, awaitingApproval: 0,
        },
        trends: { postsPublished: '—', searchImpressions: '—', hoursSaved: '—', awaitingApproval: '—' },
        counts: {
            publishedCurrent: 0, publishedPrior: 0, awaitingApproval: 0,
            searchImpressions: null, trackedPosts: 0, hoursSaved: 0,
        },
    };
}

/** Plural-safe "N post(s)". Used in trend lines, where "1 posts" is the tell of a generated string. */
function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * Period-over-period growth as a signed fraction, or null when there is no baseline to grow from.
 *
 * ⚠️ Returns null — NOT +100% — when the prior window is 0. Every "first post ever" would otherwise
 * report infinite growth, and the second month would report a crash back to 0%. With no baseline
 * there is no growth figure, and saying so is the only honest answer.
 */
export function publishedGrowth(current: number, prior: number): number | null {
    if (prior <= 0) return null;
    return (current - prior) / prior;
}

export function buildBlogPerformance(
    counts: BlogPerformanceCounts,
    days = BLOG_PERFORMANCE_DAYS,
): BlogPerformancePayload {
    // "Has data" is about whether this assistant has DONE anything worth reporting, not whether
    // every card can be filled. A Blog Writer with drafts in review and no publications yet has a
    // real, useful card 4 — hiding the whole grid behind "nothing published" would be wrong about
    // it, which is the exact failure this file replaces.
    const hasData = counts.publishedCurrent > 0
        || counts.publishedPrior > 0
        || counts.awaitingApproval > 0
        || counts.hoursSaved > 0;

    if (!hasData) return { ...emptyBlogPerformance(days), counts };

    const growth = publishedGrowth(counts.publishedCurrent, counts.publishedPrior);

    return {
        hasData: true,
        periodDays: days,
        metrics: {
            postsPublished: counts.publishedCurrent,
            publishedGrowth: growth,
            searchImpressions: counts.searchImpressions,
            hoursSaved: counts.hoursSaved,
            awaitingApproval: counts.awaitingApproval,
        },
        trends: {
            postsPublished: growth === null
                // No baseline: state the raw comparison instead of a percentage that would be a lie.
                ? (counts.publishedPrior === 0 && counts.publishedCurrent > 0 ? 'First in this window' : '—')
                : `${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(0)}% vs previous`,
            searchImpressions: counts.searchImpressions === null
                ? 'Connect Search Console'
                // Names the denominator: a big number over 2 tracked posts means something very
                // different from the same number over 40, and the card cannot say which without it.
                : plural(counts.trackedPosts, 'post tracked', 'posts tracked'),
            hoursSaved: counts.hoursSaved > 0
                ? plural(counts.publishedCurrent, 'post written', 'posts written')
                : '—',
            awaitingApproval: counts.awaitingApproval > 0 ? 'Waiting on you' : 'All clear',
        },
        counts,
    };
}
