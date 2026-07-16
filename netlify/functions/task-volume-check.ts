// task-volume-check.ts
// Scheduled Netlify function — runs daily to check each user's monthly task usage.
// SC3: fires a notification at 80% of monthly allowance and pauses automated
//      tasks + notifies again at 100%.
//
// Schedule: configure in netlify.toml as:
//   [functions.task-volume-check]
//   schedule = "0 8 * * *"   # 08:00 UTC every day

import { Handler } from '@netlify/functions';
import { eq, and, gte, count, isNotNull } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { users, plans, masterPlans, taskRuns, notifications, aiAssistants } from '../../db/schema';
import { effectiveLimit, type FeatureOverrides } from '../../src/utils/plan-features';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    // Accept both scheduled invocations and a GET call for manual testing
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const db = getDb();

        // ── Fetch all active plans that have a monthly task limit ──
        const activePlans = await db
            .select({
                userId: plans.userId,
                planId: plans.id,
                tierKey: masterPlans.tierKey,
                tierName: masterPlans.name,
                monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                featureOverrides: plans.featureOverrides,
            })
            .from(plans)
            .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(
                eq(plans.status, 'active'),
                isNotNull(masterPlans.monthlyTaskLimit),
            ));

        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthLabel = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

        let notified80 = 0;
        let paused100  = 0;

        for (const plan of activePlans) {
            // Plan Features: prefer a "new subscribers only" frozen snapshot over the live master limit.
            const limit = effectiveLimit(plan.featureOverrides as FeatureOverrides | null, 'monthlyTaskLimit', plan.monthlyTaskLimit);
            if (limit == null) continue;      // frozen as unlimited → no volume warnings
            if (plan.userId == null) continue; // plans.userId is nullable; skip org-only plans
            const userId = plan.userId;

            // Count tasks this month
            const [{ value: taskCount }] = await db
                .select({ value: count() })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.userId, userId),
                    gte(taskRuns.createdAt, monthStart),
                ));

            const pct = Math.round((taskCount / limit) * 100);

            if (pct >= 100) {
                // ── 100%: pause automated tasks + deduplicated notification ──
                const existingPause = await db
                    .select({ id: notifications.id, metadata: notifications.metadata })
                    .from(notifications)
                    .where(and(
                        eq(notifications.userId, userId),
                        eq(notifications.type, 'task_limit_reached'),
                        gte(notifications.createdAt, monthStart),
                    ))
                    .limit(1);

                // Only fire once per calendar month — check metadata
                const alreadyPaused = existingPause.some(n => {
                    const meta = n.metadata as Record<string, unknown> | null;
                    return meta?.month === monthLabel;
                });

                if (!alreadyPaused) {
                    // Pause all active assistants' automated tasks (set status hint in metadata)
                    // Actual task execution is gated via check-capacity; this notification is
                    // the user-facing signal. For immediate effect we mark assistants as paused.
                    await db
                        .update(aiAssistants)
                        .set(withUpdatedAt({ isActive: false }))
                        .where(and(
                            eq(aiAssistants.userId, userId),
                            eq(aiAssistants.provisioningStatus, 'complete'),
                        ))
                        .catch(err => console.warn('[task-volume-check] Pause assistants failed:', err.message));

                    await db.insert(notifications).values({
                        userId,
                        type: 'task_limit_reached',
                        title: 'Monthly Task Limit Reached — Automated Tasks Paused',
                        message: `You've used all ${limit.toLocaleString()} tasks included in your ${plan.tierName} plan for ${monthLabel}. `
                            + `Automated tasks have been paused. Manual "on-command" tasks still work. `
                            + `Upgrade your plan to resume automation immediately, or tasks will restart at the beginning of next month.`,
                        isRead: false,
                        metadata: { month: monthLabel, taskCount, limit, tierKey: plan.tierKey },
                    });

                    paused100++;
                }

            } else if (pct >= 80) {
                // ── 80%: warn user — deduplicated ──────────────────────────
                const existingWarn = await db
                    .select({ id: notifications.id, metadata: notifications.metadata })
                    .from(notifications)
                    .where(and(
                        eq(notifications.userId, userId),
                        eq(notifications.type, 'task_limit_warning'),
                        gte(notifications.createdAt, monthStart),
                    ))
                    .limit(1);

                const alreadyWarned = existingWarn.some(n => {
                    const meta = n.metadata as Record<string, unknown> | null;
                    return meta?.month === monthLabel;
                });

                if (!alreadyWarned) {
                    const remaining = limit - taskCount;
                    await db.insert(notifications).values({
                        userId,
                        type: 'task_limit_warning',
                        title: `You've used ${pct}% of your monthly task allowance`,
                        message: `Your ${plan.tierName} plan includes ${limit.toLocaleString()} tasks per month. `
                            + `You have used ${taskCount.toLocaleString()} (${pct}%) with ${remaining.toLocaleString()} remaining. `
                            + `Automated tasks will pause if you reach 100%. Consider upgrading for a higher limit.`,
                        isRead: false,
                        metadata: { month: monthLabel, taskCount, limit, pct, tierKey: plan.tierKey },
                    });

                    notified80++;
                }
            }
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, checked: activePlans.length, notified80, paused100 }),
        };

    } catch (err: any) {
        console.error('[task-volume-check]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Task volume check failed.' }) };
    }
});
