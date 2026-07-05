// GET ?id=<assistantId>&period=week|month (default week)
// Returns per-platform post counts (created / scheduled / published) for a single assistant,
// plus hours saved and GBP saved based on the user's configured hourly rate.

import { Handler } from '@netlify/functions';
import { and, eq, gte, sql, count } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, scheduledPosts, taskRuns, userProfiles } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { parseRoiPeriod, roiPeriodStart } from '../../src/utils/roi-period';

const PUBLISHED_STATUSES = new Set(['published']);
const SCHEDULED_STATUSES = new Set(['scheduled', 'approved', 'pending_approval', 'in_review']);

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId || Number.isNaN(parseInt(assistantId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    }
    const aId = parseInt(assistantId);

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    try {
        // IDOR guard
        const [assistant] = await withTenant(orgId, (tx) =>
            tx.select({ id: aiAssistants.id })
              .from(aiAssistants)
              .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
              .limit(1)
        );
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

        // Issue #110: the hero "hours/£ saved" figures must match the dashboard's
        // roi-stats widget. The dashboard has a This Week / This Month toggle, so
        // this endpoint takes the same ?period param and computes the window via
        // the shared roiPeriodStart helper — a hard-coded week here diverged from
        // the dashboard whenever it was on the month view (the calendar week can
        // reach into the previous month, so "this week" can exceed "this month").
        // The totals below (created/scheduled/published breakdown) stay all-time;
        // only the ROI hero uses this window.
        const period = parseRoiPeriod(event.queryStringParameters?.period);
        const periodStart = roiPeriodStart(period);

        const [postRows, profileRow, mult, [{ postsInPeriod }], [{ taskRunsInPeriod }]] = await Promise.all([
            db.select({
                status: scheduledPosts.status,
                platform: scheduledPosts.platform,
                c: sql<number>`count(*)::int`,
            })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.assistantId, aId), eq(scheduledPosts.organisationId, orgId)))
            .groupBy(scheduledPosts.status, scheduledPosts.platform),

            db.select({ preferences: userProfiles.preferences })
              .from(userProfiles)
              .where(eq(userProfiles.userId, userId))
              .limit(1),

            getTimeMultipliers(),

            db.select({ postsInPeriod: count() })
              .from(scheduledPosts)
              .where(and(
                  eq(scheduledPosts.assistantId, aId),
                  eq(scheduledPosts.organisationId, orgId),
                  gte(scheduledPosts.createdAt, periodStart)
              )),

            // Issue #110 (follow-up): window on COALESCE(completed_at, created_at) —
            // see roi-stats.ts for why filtering on created_at alone can zero this out.
            db.select({ taskRunsInPeriod: count() })
              .from(taskRuns)
              .where(and(
                  eq(taskRuns.assistantId, aId),
                  eq(taskRuns.organisationId, orgId),
                  eq(taskRuns.status, 'completed'),
                  gte(sql`coalesce(${taskRuns.completedAt}, ${taskRuns.createdAt})`, periodStart)
              )),
        ]);

        const prefs = (profileRow[0]?.preferences as Record<string, any>) || {};
        const hourlyRateGbp = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        // Aggregate by platform
        const byPlatform: Record<string, { created: number; scheduled: number; published: number }> = {};
        let totalCreated = 0, totalScheduled = 0, totalPublished = 0;

        for (const r of postRows) {
            const p = r.platform || 'unknown';
            if (!byPlatform[p]) byPlatform[p] = { created: 0, scheduled: 0, published: 0 };
            byPlatform[p].created += r.c;
            totalCreated += r.c;
            if (SCHEDULED_STATUSES.has(r.status)) { byPlatform[p].scheduled += r.c; totalScheduled += r.c; }
            if (PUBLISHED_STATUSES.has(r.status)) { byPlatform[p].published += r.c; totalPublished += r.c; }
        }

        // Same formula as roi-stats.ts (posts × content_drafted + completed task runs × tasks_completed)
        // so a single-assistant org sees identical hero figures on both pages.
        const totalMinutesInPeriod = Number(postsInPeriod) * mult.content_drafted + Number(taskRunsInPeriod) * mult.tasks_completed;
        const hoursSaved = parseFloat((totalMinutesInPeriod / 60).toFixed(1));
        const gbpSaved = hourlyRateGbp ? parseFloat((hoursSaved * hourlyRateGbp).toFixed(2)) : null;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                totalCreated,
                totalScheduled,
                totalPublished,
                byPlatform,
                hoursSaved,
                gbpSaved,
                period,
                hourlyRateSet: hourlyRateGbp !== null,
                minutesPerPost: mult.content_drafted,
            }),
        };
    } catch (err) {
        // This card is a SUPPLEMENTARY panel on the assistant detail page — a failure here
        // (DB hiccup, RLS/connection issue, brand-new assistant, etc.) must never 500 the
        // whole page. Degrade to a safe "no data" shape and log the real cause server-side.
        console.error('[get-assistant-metrics] degraded to no-data after error:', err);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                totalCreated: 0,
                totalScheduled: 0,
                totalPublished: 0,
                byPlatform: {},
                hoursSaved: 0,
                gbpSaved: null,
                period: parseRoiPeriod(event.queryStringParameters?.period),
                hourlyRateSet: false,
                minutesPerPost: null,
            }),
        };
    }
};
