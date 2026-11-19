// netlify/functions/ingest-linkedin-insights.ts
// Scheduled ingester for posts published to a LinkedIn COMPANY PAGE — the LinkedIn counterpart of
// ingest-facebook-insights.ts. Each tick, per Page connection:
//   1. per-post organic statistics → post_insights (impressions, unique impressions, likes,
//      comments, shares), so the Results tab and goals see LinkedIn the way they see Facebook;
//   2. new comments on those posts → page_comments, for the Comments tab (src/utils/page-comments.ts).
//
// Only Community-app connections (external_user_id = urn:li:organization:*) are read: a personal
// profile connection holds w_member_social only, and LinkedIn gives members no post statistics.
//
// ── Columns ──────────────────────────────────────────────────────────────────────────────────
// reach ← uniqueImpressionsCount; impressions ← impressionCount. linkClicks stays NULL: LinkedIn's
// clickCount counts clicks on the content, the Page name and its logo, which is not traffic to the
// business — the same reason ingest-facebook-insights.ts refuses post_clicks as a link-click count.
// clickCount is kept in `raw`.
//
// Schedule: every 6 hours (netlify.toml), same 30-day window as Facebook/Instagram. PRODUCTION ONLY —
// staging is driven by run-insights-ingest.ts.

import { getDb } from '../../db/client';
import { postInsights } from '../../db/schema';
import { fetchPostStatistics } from '../../src/utils/linkedin-page-api';
import { INGEST_COMMENTS_BUDGET_MS, MAX_REPORTED_FAILURES, isMissingTable, loadPagePosts, pageToken, syncCommentsForConnection, type SyncResult } from '../../src/utils/page-comments';
import { withLambda } from '@netlify/aws-lambda-compat';

export type LinkedInIngestResult = {
    connections: number; processed: number; updated: number; failed: number;
    comments: { added: number; repliedOnLinkedIn: number; failedPosts: number; skippedForTime: number; failures: NonNullable<SyncResult['failures']> } | { skipped: string };
    skipped?: string;
    durationMs: number;
};

export async function ingestLinkedInInsights(): Promise<LinkedInIngestResult> {
    const db = getDb();
    const tickStart = Date.now();
    let groups: Awaited<ReturnType<typeof loadPagePosts>>;
    try {
        groups = await loadPagePosts(db);
    } catch (err) {
        // Page posts are picked by their recorded author (db/z-scheduled-posts-author.sql). Until that
        // column exists there is nothing safe to read — skip the whole tick, don't 500 the schedule.
        if (!isMissingTable(err)) throw err;
        const skipped = 'scheduled_posts.platform_author_urn missing — apply db/z-scheduled-posts-author.sql';
        console.warn(`[ingest-linkedin-insights] ${skipped}`);
        return { connections: 0, processed: 0, updated: 0, failed: 0, comments: { skipped }, skipped, durationMs: Date.now() - tickStart };
    }

    let processed = 0, updated = 0, failed = 0;
    let comments: LinkedInIngestResult['comments'] = { added: 0, repliedOnLinkedIn: 0, failedPosts: 0, skippedForTime: 0, failures: [] };
    // Comments make one call per post plus reply lookups; statistics are one call per 20 posts. So the
    // comments half carries the time budget — a busy tick defers comments to the next run, never stats.
    const commentsDeadline = tickStart + INGEST_COMMENTS_BUDGET_MS;

    for (const [connectionId, g] of groups) {
        processed += g.posts.length;
        const token = await pageToken(db, g.organisationId, connectionId);
        if (!token) { failed += g.posts.length; continue; }

        // 1. Statistics — one call per 20 posts of each URN kind.
        const stats = await fetchPostStatistics(token, g.orgUrn, g.posts.map((p) => p.platformPostId));
        for (const post of g.posts) {
            const s = stats.get(post.platformPostId);
            if (!s) { failed++; continue; }
            const row = {
                organisationId: post.organisationId,
                assistantId: post.assistantId ?? null,
                connectionId,
                platform: 'linkedin',
                platformPostId: post.platformPostId,
                publishedAt: post.publishedAt ?? null,
                reach: s.uniqueImpressions,
                impressions: s.impressions,
                likes: s.likes,
                comments: s.comments,
                shares: s.shares,
                // LinkedIn has no saves for Page posts. Null, not 0 (see ingest-facebook-insights.ts).
                saves: null,
                totalInteractions: [s.likes, s.comments, s.shares].reduce<number>((sum, v) => sum + (v ?? 0), 0),
                videoViews: null,
                linkClicks: null,
                raw: { totalShareStatistics: s },
                fetchedAt: new Date(),
                updatedAt: new Date(),
            };
            try {
                await db.insert(postInsights)
                    .values({ scheduledPostId: post.id, ...row })
                    .onConflictDoUpdate({ target: postInsights.scheduledPostId, set: row });
                updated++;
            } catch (err) {
                console.error(`[ingest-linkedin-insights] post ${post.id}:`, err instanceof Error ? err.message : err);
                failed++;
            }
        }

        // 2. Comments. A missing page_comments table (SQL not applied yet) skips this half only.
        if ('skipped' in comments) continue;
        try {
            const r = await syncCommentsForConnection(db, { connectionId, orgUrn: g.orgUrn, token, posts: g.posts, deadline: commentsDeadline });
            comments.skippedForTime += r.skippedForTime;
            comments.added += r.added;
            comments.repliedOnLinkedIn += r.repliedOnLinkedIn;
            comments.failedPosts += r.failedPosts;
            for (const f of r.failures ?? []) if (comments.failures.length < MAX_REPORTED_FAILURES) comments.failures.push(f);
        } catch (err) {
            if (isMissingTable(err)) { comments = { skipped: 'page_comments table missing — apply db/z-page-comments.sql' }; continue; }
            console.error(`[ingest-linkedin-insights] conn ${connectionId} comments:`, err instanceof Error ? err.message : err);
        }
    }

    const durationMs = Date.now() - tickStart;
    console.log(`[ingest-linkedin-insights] connections=${groups.size} processed=${processed} updated=${updated} failed=${failed} comments=${JSON.stringify(comments)} ${durationMs}ms`);
    return { connections: groups.size, processed, updated, failed, comments, durationMs };
}

// The scheduled entry point (netlify.toml → every 6 hours). PRODUCTION ONLY.
export default withLambda(async () => {
    const result = await ingestLinkedInInsights();
    return { statusCode: 200, body: JSON.stringify(result) };
});
