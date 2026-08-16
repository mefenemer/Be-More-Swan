// netlify/functions/roi-stats.ts
// US-AUD-1.2.1: ROI aggregation — task runs × avg duration × hourly rate.
//
//  GET ?period=all|month|week   (default: all)
//   → { taskCount, hoursSaved, gbpSaved, planCostGbp, multiplier, period }

import { HandlerEvent } from '@netlify/functions';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles, plans, masterPlans, notifications } from '../../db/schema';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { activeAssistantIds, countRoiActivity } from '../../src/utils/roi-activity';
import { createNotification } from '../../src/utils/notify';
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
    // Default 'all': both calendar windows cliff-drop to zero the moment they roll
    // over, so a month-defaulted hero reported 0 hours / £0 / 0 tasks on the morning
    // of the 1st despite a full month of activity the day before. See roi-period.ts.
    const period = raw ? parseRoiPeriod(raw) : 'all';

    // SC6: Date range — all time, or the current calendar month or week, computed by
    // the shared helper so get-assistant-metrics.ts aggregates over the identical window.
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

        // This is the dashboard's aggregate ROI card, so it sums the work of EVERY active
        // assistant — 'active' == not archived, so a retired assistant's history stops
        // inflating the org total but a paused one keeps the work it already did.
        //
        // What counts, and why it is not defined here: src/utils/roi-activity.ts. This used
        // to hand-roll three counts, one of which read the `leads` table — Be More Swan's OWN
        // sales pipeline, not the tenant's — while every assistant that files its output to
        // assistant_records (Lead Generator, Meeting Note Taker, Campaign Orchestrator, the
        // ticket/invoice roles) contributed exactly zero. That is what "the card isn't
        // aggregating from all active assistants" looked like from the dashboard.
        const assistantIds = await activeAssistantIds(db, organisationId);

        // SC1: minutes saved per item — admin-configurable via gamification.time_multipliers.
        // Fetched once and threaded through both countRoiActivity calls below.
        const mult = await getTimeMultipliers();

        // Factored out because the monthly break-even milestone below has to keep evaluating on
        // a calendar-month window even when the caller asked for 'all' — which is the dashboard's
        // default, so a month-only milestone check would otherwise almost never run again.
        const countActivity = (windowStart: Date) => countRoiActivity(db, {
            organisationId, assistantIds, windowStart, multipliers: mult,
        });

        const windowStats = await countActivity(periodStart);
        const { completedTasks, hoursSaved } = windowStats;

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

        // Break-even is inherently a CALENDAR-MONTH question: planCostGbp is a monthly
        // price, so it can only be compared against a month's worth of savings. When the
        // caller asked for 'all' or 'week' we therefore re-count over the month window
        // rather than comparing a lifetime (or part-week) figure against one month's cost,
        // which would otherwise report an ever-growing, meaningless multiplier.
        // The extra queries only run when a multiplier is actually computable.
        const breakEvenPossible = hourlyRate !== null && planCostGbp !== null && planCostGbp > 0;
        const monthStats = !breakEvenPossible ? null
            : period === 'month' ? windowStats
            : await countActivity(roiPeriodStart('month', now));
        const monthGbpSaved = monthStats && hourlyRate !== null
            ? parseFloat((monthStats.hoursSaved * hourlyRate).toFixed(2))
            : null;

        // SC2: multiplier = this month's gbpSaved / planCostGbp
        let multiplier: number | null = null;
        if (monthGbpSaved !== null && planCostGbp !== null && planCostGbp > 0) {
            multiplier = parseFloat((monthGbpSaved / planCostGbp).toFixed(1));
        }

        // SC3: tasksToBreakEven — only if this month is below break-even
        let tasksToBreakEven: number | null = null;
        if (monthStats && monthGbpSaved !== null && hourlyRate && planCostGbp && monthGbpSaved < planCostGbp) {
            const hoursNeeded = planCostGbp / hourlyRate;
            const tasksNeeded = Math.ceil((hoursNeeded * 60) / monthStats.avgTaskDurationMinutes);
            tasksToBreakEven = Math.max(0, tasksNeeded - monthStats.completedTasks);
        }

        // Issue #84: notify the user once per calendar month when they first cross
        // break-even, instead of a permanently-visible banner. Fire-and-forget so it
        // never blocks the response; dedup on the most recent 'roi_milestone' row's
        // periodKey so it fires at most once per month.
        if (monthGbpSaved !== null && multiplier !== null && multiplier >= 1) {
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
                    await createNotification(db, 'roi_milestone', {
                        userId,
                        context: { roi: { saved: monthGbpSaved.toFixed(2), multiplier } },
                        metadata: { periodKey, gbpSaved: monthGbpSaved, multiplier },
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
                // Always a CALENDAR-MONTH figure whatever `period` is, because both are
                // measured against the monthly plan price. Label them "this month" in the
                // UI even when the tiles above them are showing all-time totals.
                multiplier,
                tasksToBreakEven,
                multiplierPeriod: 'month',
                hourlyRateSet: hourlyRate !== null,
                // Which assistants and which activity sources produced the figures above, so the
                // tiles can be reconciled against the "tasks behind this" modal without a second
                // definition of the same sum living in the client.
                assistantsCounted: assistantIds.length,
                sources: windowStats.breakdown,
                // True when a source query failed and was defaulted to 0 rather than 500ing the
                // whole widget — the numbers are then a floor, not a total.
                partial: windowStats.degraded,
            }),
        };
    } catch (err) {
        console.error('roi-stats error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to compute ROI stats.' }) };
    }
});
