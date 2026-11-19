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
