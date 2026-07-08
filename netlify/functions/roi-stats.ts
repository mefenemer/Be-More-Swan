// netlify/functions/roi-stats.ts
// US-AUD-1.2.1: ROI aggregation — task runs × avg duration × hourly rate.
//
//  GET ?period=month|week
//   → { taskCount, hoursSaved, gbpSaved, planCostGbp, multiplier, period }

import { HandlerEvent } from '@netlify/functions';
import { eq, and, gte, count, desc, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles, taskRuns, scheduledPosts, leads, plans, masterPlans, notifications } from '../../db/schema';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { requireSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { parseRoiPeriod, roiPeriodStart } from '../../src/utils/roi-period';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const session = requireSession(event);
    if ('error' in session) return session.error;
    const userId = session.userId;
    const raw = event.queryStringParameters?.period;
    const period = raw ? parseRoiPeriod(raw) : 'month';

    // SC6: Date range — current calendar month or week, computed by the shared
    // helper so get-assistant-metrics.ts aggregates over the identical window.
    const now = new Date();
    const periodStart = roiPeriodStart(period, now);

    try {
        // Resolve the user's ACTIVE organisation (not just any membership) — task/post
        // activity is org-wide (created by any teammate or by an assistant acting on the
        // org's behalf), but must be scoped to the org the user is currently working in,
        // same as get-time-saved.ts, so the "tasks behind this" modal (which uses
        // requireTenant) always agrees with this widget's count.
        const org = await resolveActiveOrg(db, userId, session.activeOrganisationId);
        const organisationId = org?.organisationId ?? null;

        // Issue #132 (follow-up) / issue #149: the reporter saw this widget go from
        // "0" to completely blank after the coalesce/leads changes below landed — i.e.
        // one of these queries started throwing, which turned the whole response into a
        // 500 (the frontend leaves the tiles in their loading-skeleton state on any
        // non-200 response). Whatever the exact trigger, a single activity source
        // failing must never blank the entire widget again, so each count is now
        // isolated and defaults to 0 on error instead of aborting the request.
        const safeCount = async (query: Promise<{ count: number }[]>): Promise<number> => {
            try {
                const [row] = await query;
                return Number(row?.count ?? 0);
            } catch (err) {
                console.error('roi-stats: activity count query failed, defaulting to 0', err);
                return 0;
            }
        };

        // SC6: Count completed task runs and drafted/scheduled posts in the period.
        // Real assistant work (e.g. the social media assistant) is recorded in
        // scheduled_posts — task_runs alone is near-always empty for that flow, which
        // is why this widget previously showed zero despite an assistant being active
        // (see get-assistant-metrics.ts, which already reads from scheduled_posts).
        //
        // Issue #110 (follow-up): task_runs are windowed on COALESCE(completed_at,
        // created_at), not created_at alone — a run created before the period boundary
        // but only completing after it (the normal case right after a week/month rolls
        // over) was being dropped entirely, zeroing out this widget even with completed
        // work in the window. dashboard-heatmap.ts already uses this same COALESCE for
        // task_runs; this brings the ROI hero in line with it.
        //
        // The comparand must be an ISO string, not a Date: a raw sql`` fragment has no
        // column type, so drizzle passes a Date through to postgres-js unserialized and
        // the bind step throws ERR_INVALID_ARG_TYPE (500 on every call).
        const taskRunCount = organisationId ? await safeCount(db
            .select({ count: count() })
            .from(taskRuns)
            .where(and(
                eq(taskRuns.organisationId, organisationId),
                eq(taskRuns.status, 'completed'),
                gte(sql`coalesce(${taskRuns.completedAt}, ${taskRuns.createdAt})`, periodStart.toISOString())
            ))) : 0;

        const postCount = organisationId ? await safeCount(db
            .select({ count: count() })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, organisationId),
                gte(scheduledPosts.createdAt, periodStart)
            ))) : 0;

        // Leads generated in the period — get-time-saved.ts already counts these towards
        // "Hours Saved"; omitting them here meant an org whose assistant work is mostly lead
        // generation (no task_runs, no scheduled_posts yet) saw 0 hours/£/tasks on this
        // widget despite real, non-zero activity on the modal it's supposed to agree with.
        const leadCount = organisationId ? await safeCount(db
            .select({ count: count() })
            .from(leads)
            .where(and(
                eq(leads.organisationId, organisationId),
                gte(leads.createdAt, periodStart)
            ))) : 0;

        const completedTasks = Number(taskRunCount) + Number(postCount) + Number(leadCount);

        // SC1: minutes saved per item — admin-configurable via gamification.time_multipliers,
        // shared with the dashboard "Hours Saved" widget (get-time-saved.ts) so both views
        // stay consistent. Task runs, drafted posts, and generated leads each use their own multiplier.
        const mult = await getTimeMultipliers();
        const totalMinutes = Number(taskRunCount) * mult.tasks_completed
            + Number(postCount) * mult.content_drafted
            + Number(leadCount) * mult.leads_generated;
        const avgTaskDurationMinutes = completedTasks > 0 ? totalMinutes / completedTasks : mult.tasks_completed;

        // SC1: hours saved = total minutes / 60
        const hoursSaved = parseFloat((totalMinutes / 60).toFixed(1));

        // Get hourly rate from profile preferences
        const [profile] = await db
            .select({ preferences: userProfiles.preferences })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);
        const prefs = (profile?.preferences as Record<string, any>) || {};
        const hourlyRate = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        const gbpSaved = hourlyRate ? parseFloat((hoursSaved * hourlyRate).toFixed(2)) : null;

        // Get plan cost for break-even calculation (SC2/SC3)
        let planCostGbp: number | null = null;
        let currency = 'GBP';
        if (organisationId) {
            const [plan] = await db
                .select({ monthlyPriceGbp: masterPlans.monthlyPriceGbp })
                .from(plans)
                .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(eq(plans.organisationId, organisationId), eq(plans.status, 'active')))
                .limit(1);
            if (plan?.monthlyPriceGbp) {
                planCostGbp = parseFloat(String(plan.monthlyPriceGbp));
            }
            // masterPlans pricing is GBP-only (monthlyPriceGbp); currency stays 'GBP'.
        }

        // SC2: multiplier = gbpSaved / planCostGbp (only for monthly period)
        let multiplier: number | null = null;
        if (period === 'month' && gbpSaved !== null && planCostGbp !== null && planCostGbp > 0) {
            multiplier = parseFloat((gbpSaved / planCostGbp).toFixed(1));
        }

        // SC3: tasksToBreakEven — only if below break-even
        let tasksToBreakEven: number | null = null;
        if (period === 'month' && hourlyRate && planCostGbp && gbpSaved !== null && gbpSaved < planCostGbp) {
            const hoursNeeded = planCostGbp / hourlyRate;
            const tasksNeeded = Math.ceil((hoursNeeded * 60) / avgTaskDurationMinutes);
            tasksToBreakEven = Math.max(0, tasksNeeded - completedTasks);
        }

        // Issue #84: notify the user once per calendar month when they first cross
        // break-even, instead of a permanently-visible banner. Fire-and-forget so it
        // never blocks the response; dedup on the most recent 'roi_milestone' row's
        // periodKey so it fires at most once per month.
        if (period === 'month' && gbpSaved !== null && multiplier !== null && multiplier >= 1) {
            const periodKey = `${now.getFullYear()}-${now.getMonth()}`;
            void (async () => {
                try {
                    const [existing] = await db
                        .select({ metadata: notifications.metadata })
                        .from(notifications)
                        .where(and(eq(notifications.userId, userId), eq(notifications.type, 'roi_milestone')))
                        .orderBy(desc(notifications.createdAt))
                        .limit(1);
                    if (existing && (existing.metadata as Record<string, unknown> | null)?.periodKey === periodKey) return;
                    await db.insert(notifications).values({
                        userId,
                        type: 'roi_milestone',
                        title: 'Your assistants are paying for themselves!',
                        message: `£${gbpSaved.toFixed(2)} saved this month — ${multiplier}× your subscription cost — your assistants are paying for themselves.`,
                        metadata: { periodKey, gbpSaved, multiplier },
                    });
                } catch { /* non-blocking */ }
            })();
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                period,
                taskCount: completedTasks,
                hoursSaved,
                gbpSaved,
                amountSaved: gbpSaved,    // US-I18N-2.1 SC5: currency-neutral alias — format with `currency`
                planCostGbp,
                planCost: planCostGbp,    // US-I18N-2.1 SC5: currency-neutral alias
                currency,                 // user's billing currency — use with Intl.NumberFormat
                multiplier,
                tasksToBreakEven,
                hourlyRateSet: hourlyRate !== null,
            }),
        };
    } catch (err) {
        console.error('roi-stats error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to compute ROI stats.' }) };
    }
});
