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

import { and, count, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, blogPosts, workspaceIntegrations } from '../../db/schema';
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
            gscRows,
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
            // Is Search Console actually connected? Without this, "0 impressions" would be reported
            // to a workspace that has never connected it — a measured zero invented out of an
            // absent integration, which is the same class of bug as linkedin_followers.
            db.select({ count: count() }).from(workspaceIntegrations)
                .where(and(
                    eq(workspaceIntegrations.organisationId, orgId),
                    eq(workspaceIntegrations.provider, 'searchconsole'),
                    eq(workspaceIntegrations.status, 'active'),
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
