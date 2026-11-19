// src/utils/post-results.ts
// A published post's own results, as the post's "Posted" note shows them (workspace.html
// _rqResultsHtml). Read from post_insights, which the scheduled ingests fill:
// ingest-linkedin-insights.ts (Company Page posts), ingest-facebook-insights.ts,
// ingest-instagram-insights.ts. Pure, so the shape is tested without a database.

/** Platforms whose posts have results ingested. Any other platform's note shows no results line. */
export const RESULTS_PLATFORMS = ['linkedin', 'facebook', 'instagram'] as const;

export type PostResults = {
    impressions: number | null;
    reach: number | null;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
    videoViews: number | null;
    fetchedAt: string | null;
};

type InsightRow = {
    impressions: number | null; reach: number | null; likes: number | null; comments: number | null;
    shares: number | null; videoViews: number | null; fetchedAt: Date | string | null;
};

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** One post_insights row → what the note shows. A metric the platform doesn't give stays null (shown as nothing, never 0). */
export function postResultsView(row: InsightRow): PostResults {
    const at = row.fetchedAt instanceof Date ? row.fetchedAt.toISOString() : (typeof row.fetchedAt === 'string' ? row.fetchedAt : null);
    return {
        impressions: n(row.impressions),
        reach: n(row.reach),
        reactions: n(row.likes),
        comments: n(row.comments),
        shares: n(row.shares),
        videoViews: n(row.videoViews),
        fetchedAt: at,
    };
}

/** How far back every results ingest reads (ingest-facebook/instagram-insights WINDOW_DAYS, page-comments COMMENT_WINDOW_DAYS). */
export const RESULTS_WINDOW_DAYS = 30;

/**
 * What the note may say about a published post that has no results yet:
 *  'pending'          — an ingest will read it (the right platform and account, inside the window): "they appear in a few hours";
 *  'personal_profile' — a LinkedIn post on a personal profile: LinkedIn gives members no post results, so say so;
 *  null               — nothing is coming (outside the window, or no ingest): say nothing rather than promise. Pure.
 */
export function resultsExpectation(
    post: { platform: string | null; publishedAt: Date | string | null; platformAuthorUrn: string | null },
    now: number = Date.now(),
): 'pending' | 'personal_profile' | null {
    const platform = String(post.platform ?? '').toLowerCase();
    if (!(RESULTS_PLATFORMS as readonly string[]).includes(platform)) return null;
    if (platform === 'linkedin' && !String(post.platformAuthorUrn ?? '').startsWith('urn:li:organization:')) return 'personal_profile';
    const at = post.publishedAt ? new Date(post.publishedAt).getTime() : NaN;
    if (!Number.isFinite(at) || now - at > RESULTS_WINDOW_DAYS * 24 * 60 * 60 * 1000) return null;
    return 'pending';
}
