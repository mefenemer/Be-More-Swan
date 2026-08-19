// netlify/functions/get-blog-performance.ts
// GET ?id=<assistantId>&days=<30..365, default 90>
// Feeds the four assistant-detail "Performance Metrics" KPI cards for the Blog Writer. The
// arithmetic lives in src/utils/blog-performance.ts; this file is the query and the tenant guard.
//
// Deliberately SEPARATE from get-assistant-performance.ts, for the same reason
// get-lead-performance.ts and get-campaign-performance.ts are. That endpoint answers "how did this
// assistant's own posts perform" off `post_insights` — the Instagram per-post insights table. A Blog
// Writer publishes long-form to `blog_posts` and writes nothing to `post_insights` ever, so it
// returned hasData:false permanently and told every Blog Writer user that nothing had been
// published in the last 30 days: true, permanent, and about a different product.
//
// ⚠️ Hours saved comes from src/utils/roi-activity.ts, never from a local multiplication. Four
// surfaces report hours and they all count through that one module on purpose — a second, slightly
// different sum here is how two screens end up disagreeing about the same assistant.
//
// ⚠️ Search impressions read `blog_posts.traffic_baseline`, which ingest-gsc-metrics.ts maintains as
// the PEAK impressions seen for a post (it exists to detect decay against that peak). It is not a
// windowed total, and the card is labelled "Search Impressions" rather than "Organic Traffic" for
// that reason. Reporting it as period traffic would be a number that never falls.
//
// ⚠️ Search CLICKS (`blog_posts.search_clicks`) are the opposite shape — the latest windowed
// measurement, overwritten daily. The two are summed separately and must never be divided into
// each other to produce a click-through rate. See db/blog-search-clicks.sql.

import { and, count, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, blogEngagementStats, blogPosts, workspaceIntegrations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { countRoiActivity } from '../../src/utils/roi-activity';
import {
    BLOG_PERFORMANCE_DAYS, buildBlogPerformance, emptyBlogPerformance,
    type BlogPerformanceCounts,
} from '../../src/utils/blog-performance';
import { withLambda } from '@netlify/aws-lambda-compat';

const MIN_DAYS = 30;
const MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const rawId = event.queryStringParameters?.id;
    if (!rawId || Number.isNaN(parseInt(rawId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    }
    const assistantId = parseInt(rawId);

    const rawDays = parseInt(event.queryStringParameters?.days || '');
    const periodDays = Number.isNaN(rawDays)
        ? BLOG_PERFORMANCE_DAYS
        : Math.min(MAX_DAYS, Math.max(MIN_DAYS, rawDays));

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    const json = (body: unknown) => ({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    try {
        // IDOR guard — same shape as get-assistant-performance.ts.
        const [assistant] = await withTenant(orgId, (tx) =>
            tx.select({ id: aiAssistants.id })
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
                .limit(1)
        );
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

        const now = Date.now();
        const windowStart = new Date(now - periodDays * DAY_MS);
        const priorStart = new Date(now - periodDays * 2 * DAY_MS);

        const mine = and(eq(blogPosts.organisationId, orgId), eq(blogPosts.assistantId, assistantId));

        const [
            publishedCurrentRows,
            publishedPriorRows,
            awaitingRows,
            impressionRows,
            clickRows,
            gscRows,
            engagementRows,
            roi,
        ] = await Promise.all([
            db.select({ count: count() }).from(blogPosts)
                .where(and(mine, eq(blogPosts.status, 'published'), gte(blogPosts.publishedAt, windowStart))),
            db.select({ count: count() }).from(blogPosts)
                .where(and(mine, eq(blogPosts.status, 'published'),
                    gte(blogPosts.publishedAt, priorStart), lt(blogPosts.publishedAt, windowStart))),
            // NOT windowed, on purpose — see the note in blog-performance.ts. Both statuses count:
            // the schema allows 'pending_approval' and 'in_review', and a draft in either is a draft
            // the user has to look at.
            db.select({ count: count() }).from(blogPosts)
                .where(and(mine, sql`${blogPosts.status} IN ('pending_approval', 'in_review')`)),
            // Peak search impressions across every published post we have a figure for. Lifetime,
            // not windowed: traffic_baseline is a running peak, so restricting it by date would
            // silently drop the posts that are actually performing.
            db.select({
                total: sql<number>`COALESCE(SUM(${blogPosts.trafficBaseline}), 0)::int`,
                tracked: sql<number>`COUNT(*)::int`,
            }).from(blogPosts)
                .where(and(mine, eq(blogPosts.status, 'published'), isNotNull(blogPosts.trafficBaseline))),
            // Search clicks over the latest GSC window, summed across posts that have a figure.
            // A SEPARATE query from impressions above rather than another column on it, because
            // the two have different populations: a post can have impressions recorded and no
            // clicks row yet (it was last ingested before this column existed). Folding them into
            // one COUNT(*) would report the impressions denominator on the clicks card.
            db.select({
                total: sql<number>`COALESCE(SUM(${blogPosts.searchClicks}), 0)::int`,
                tracked: sql<number>`COUNT(*)::int`,
            }).from(blogPosts)
                .where(and(mine, eq(blogPosts.status, 'published'), isNotNull(blogPosts.searchClicks))),
            // Is Search Console actually connected? Without this, "0 impressions" would be reported
            // to a workspace that has never connected it — a measured zero invented out of an
            // absent integration, which is the same class of bug as linkedin_followers.
            db.select({ count: count() }).from(workspaceIntegrations)
                .where(and(
                    eq(workspaceIntegrations.organisationId, orgId),
                    eq(workspaceIntegrations.provider, 'searchconsole'),
                    eq(workspaceIntegrations.status, 'active'),
                )),
            // Reader engagement from the widget beacon (blog_engagement_stats), joined to THIS
            // assistant's published posts. Lifetime rather than windowed: the beacon writes running
            // aggregates with no per-day breakdown, so a date filter here would silently report
            // nothing. Summed, then averaged below — averaging per-post averages would weight a
            // post with 2 readers the same as one with 2,000.
            db.select({
                views: sql<number>`COALESCE(SUM(${blogEngagementStats.views}), 0)::int`,
                dwellMs: sql<number>`COALESCE(SUM(${blogEngagementStats.sumDwellMs}), 0)::bigint`,
                posts: sql<number>`COUNT(*)::int`,
            }).from(blogEngagementStats)
                .where(inArray(
                    blogEngagementStats.blogPostId,
                    db.select({ id: blogPosts.id }).from(blogPosts)
                        .where(and(mine, eq(blogPosts.status, 'published'))),
                )),
            countRoiActivity(db, { organisationId: orgId, assistantIds: [assistantId], windowStart }),
        ]);

        const gscConnected = Number(gscRows[0]?.count ?? 0) > 0;
        const counts: BlogPerformanceCounts = {
            publishedCurrent: Number(publishedCurrentRows[0]?.count ?? 0),
            publishedPrior: Number(publishedPriorRows[0]?.count ?? 0),
            awaitingApproval: Number(awaitingRows[0]?.count ?? 0),
            searchImpressions: gscConnected ? Number(impressionRows[0]?.total ?? 0) : null,
            trackedPosts: gscConnected ? Number(impressionRows[0]?.tracked ?? 0) : 0,
            // Same gate as impressions: without a connection this is "we cannot see this" (null),
            // never the measured zero that 0 would claim.
            searchClicks: gscConnected ? Number(clickRows[0]?.total ?? 0) : null,
            clickedPosts: gscConnected ? Number(clickRows[0]?.tracked ?? 0) : 0,
            // ⚠️ null when NOTHING has been measured yet, never 0. Zero seconds would be a verdict
            // on the writing; the truth is that nobody has loaded a post through the widget yet
            // (or the blog is not embedded anywhere). buildBlogPerformance keeps the two apart.
            engagementViews: Number(engagementRows[0]?.views ?? 0),
            engagementSeconds: Number(engagementRows[0]?.views ?? 0) > 0
                ? Number(engagementRows[0]?.dwellMs ?? 0) / 1000 / Number(engagementRows[0]?.views ?? 1)
                : null,
            // roi-activity degrades to 0 on a failed source rather than throwing; don't present a
            // degraded figure as a measured one.
            hoursSaved: roi.degraded ? 0 : roi.hoursSaved,
        };

        return json(buildBlogPerformance(counts, periodDays));
    } catch (err) {
        console.error('[get-blog-performance]', err);
        // A 500, NOT a 200 with an empty payload. The renderer keeps 'error' and 'no-data' apart
        // precisely so a failed query is never reported to the user as "you have published nothing".
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load blog performance.' }) };
    }
});

/** Exported for tests that want the empty shape without a database. */
export { emptyBlogPerformance };
