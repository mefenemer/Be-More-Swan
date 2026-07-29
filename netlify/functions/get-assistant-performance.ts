// GET ?id=<assistantId>&days=<7..90, default 30>
// US-SMM-PERF: feeds the four assistant-detail "Performance Metrics" KPI cards — engagement
// rate, organic reach growth, click-through rate and meaningful engagement — plus the
// sparkline series behind them. The aggregation itself lives in src/utils/post-performance.ts;
// this file is the query, the tenant guard and the window.
//
// Deliberately SEPARATE from get-assistant-metrics.ts, which owns the Created/Scheduled/
// Published totals and the hours/£ ROI strip. Two reasons: that endpoint is fetched twice on
// page load and again on every period-toggle click, so it must stay a cheap scheduled_posts
// count; and its catch-all degrades to a 200 "no activity" shape, which would silently
// swallow a genuine failure of this much heavier post_insights join.

import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, postInsights } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { buildPerformancePayload, emptyPayload, type InsightRow } from '../../src/utils/post-performance';
import { withLambda } from '@netlify/aws-lambda-compat';

const DEFAULT_DAYS = 30;
const MIN_DAYS = 7;
const MAX_DAYS = 90;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId || Number.isNaN(parseInt(assistantId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    }
    const aId = parseInt(assistantId);

    const rawDays = parseInt(event.queryStringParameters?.days || '');
    const periodDays = Number.isNaN(rawDays) ? DEFAULT_DAYS : Math.min(MAX_DAYS, Math.max(MIN_DAYS, rawDays));

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const json = (body: unknown) => ({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    try {
        // IDOR guard — same shape as get-assistant-metrics.ts.
        const [assistant] = await withTenant(orgId, (tx) =>
            tx.select({ id: aiAssistants.id })
              .from(aiAssistants)
              .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
              .limit(1)
        );
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

        const now = Date.now();
        // Two windows deep: the current period plus the one before it, which supplies the
        // growth baseline. buildPerformancePayload splits them, so this stays one query.
        const priorStart = new Date(now - periodDays * 2 * 24 * 60 * 60 * 1000);

        // post_insights is read on the getDb() owner path with an explicit organisation_id filter,
        // NOT through withTenant() — the table carries no RLS policy by design (see the header of
        // db/post-insights.sql). Both filters are load-bearing: organisationId is the tenant guard.
        //
        // Windowed on coalesce(published_at, created_at): a published post can carry a null
        // published_at, and filtering on that column alone would drop it from every figure.
        // The Date must be bound as an ISO string here — a Date inside a raw sql`` fragment dies
        // in the postgres-js bind step (see the same call in get-assistant-metrics.ts).
        const rows = (await db
            .select({
                id: postInsights.scheduledPostId,
                platform: postInsights.platform,
                publishedAt: postInsights.publishedAt,
                createdAt: postInsights.createdAt,
                reach: postInsights.reach,
                likes: postInsights.likes,
                comments: postInsights.comments,
                shares: postInsights.shares,
                saves: postInsights.saves,
                totalInteractions: postInsights.totalInteractions,
                linkClicks: postInsights.linkClicks,
            })
            .from(postInsights)
            .where(and(
                eq(postInsights.assistantId, aId),
                eq(postInsights.organisationId, orgId),
                gte(sql`coalesce(${postInsights.publishedAt}, ${postInsights.createdAt})`, priorStart.toISOString()),
            ))) as InsightRow[];

        return json(buildPerformancePayload(rows, periodDays, now));
    } catch (err) {
        // Supplementary panel — a failure must never 500 the assistant-detail page. Degrade to the
        // honest "no data yet" state and log the real cause. Worth reading that log: if
        // db/post-insights.sql was never applied to this environment, every request lands here.
        console.error('[get-assistant-performance] degraded to no-data after error:', err);
        return json(emptyPayload(periodDays));
    }
});
