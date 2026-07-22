// task-volume-check.ts
// Scheduled Netlify function — runs daily to check each org's monthly task usage.
// SC3: fires a notification at 80% of monthly allowance and pauses the org's assistants
//      + notifies again at 100%.
//
// The pause is REVERSED by resume-quota-paused.ts once the allowance resets — see the note on the
// paused_quota update below for why that needs its own provisioning status rather than is_active.
//
// Schedule: configure in netlify.toml as:
//   [functions.task-volume-check]
//   schedule = "0 8 * * *"   # 08:00 UTC every day

import { eq, and, gte, isNotNull } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { plans, masterPlans, notifications, aiAssistants, usageCounters } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { effectiveLimit, type FeatureOverrides } from '../../src/utils/plan-features';
import { getPeriodStart } from '../../src/utils/atomic-cap-check';
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
                organisationId: plans.organisationId,
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
        // MUST match enforcement exactly. atomicCapCheck (src/utils/atomic-cap-check.ts) counts
        // usage_counters.task_count per ORGANISATION over a UTC calendar month. This job used to
        // COUNT(*) task_runs per USER over a LOCAL-time month, so the two could disagree: a user
        // could be hard-stopped having never seen the 80% warning, or be told "limit reached"
        // while still able to run tasks. Same source, same period, same scope — no drift.
        const periodStart = getPeriodStart();
        const monthLabel = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

        let notified80 = 0;
        let paused100  = 0;

        for (const plan of activePlans) {
            // Plan Features: prefer a "new subscribers only" frozen snapshot over the live master limit.
            const limit = effectiveLimit(plan.featureOverrides as FeatureOverrides | null, 'monthlyTaskLimit', plan.monthlyTaskLimit);
            if (limit == null) continue;      // frozen as unlimited → no volume warnings
            if (plan.userId == null) continue; // plans.userId is nullable; skip org-only plans
            const userId = plan.userId;

            // Read the SAME counter enforcement decrements, for the same UTC period. A missing row
            // just means no task has run yet this month (atomicCapCheck upserts it on first use).
            const [counter] = await db
                .select({ taskCount: usageCounters.taskCount })
                .from(usageCounters)
                .where(and(
                    eq(usageCounters.organisationId, plan.organisationId),
                    eq(usageCounters.periodStart, periodStart),
                ))
                .limit(1);
            const taskCount = counter?.taskCount ?? 0;

            const pct = Math.round((taskCount / limit) * 100);

            if (pct >= 100) {
                // ── 100%: pause automated tasks + deduplicated notification ──
                const existingPause = await db
                    .select({ id: notifications.id, metadata: notifications.metadata })
                    .from(notifications)
                    .where(and(
                        eq(notifications.userId, userId),
                        eq(notifications.type, 'task_limit_reached'),
                        gte(notifications.createdAt, periodStart),
                    ))
                    .limit(1);

                // Only fire once per calendar month — check metadata
                const alreadyPaused = existingPause.some(n => {
                    const meta = n.metadata as Record<string, unknown> | null;
                    return meta?.month === monthLabel;
                });

                if (!alreadyPaused) {
                    // Pause the user's working assistants. Actual task execution is already gated by
                    // atomicCapCheck; this is the visible signal (and stops the drafting crons).
                    //
                    // The pause is stamped with provisioningStatus='paused_quota', NOT just
                    // isActive=false. isActive is the USER's own on/off switch, so a quota pause
                    // written only there is indistinguishable from a deliberate user action — which
                    // is why nothing could ever safely un-pause it, and assistants stayed dark
                    // forever after a single cap hit (resume-quota-paused.ts now reverses exactly
                    // these rows). Scoped to currently-WORKING assistants so we never touch one the
                    // user paused themselves, nor overwrite paused_payment / paused_limit.
                    await db
                        .update(aiAssistants)
                        .set(withUpdatedAt({ isActive: false, provisioningStatus: 'paused_quota' }))
                        .where(and(
                            eq(aiAssistants.userId, userId),
                            eq(aiAssistants.provisioningStatus, 'complete'),
                            eq(aiAssistants.isActive, true),
                        ))
                        .catch(err => console.warn('[task-volume-check] Pause assistants failed:', err.message));

                    await createNotification(db, 'task_limit_reached', {
                        userId,
                        context: { usage: { limit: limit.toLocaleString(), month: monthLabel }, plan: { tier_name: plan.tierName } },
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
                        gte(notifications.createdAt, periodStart),
                    ))
                    .limit(1);

                const alreadyWarned = existingWarn.some(n => {
                    const meta = n.metadata as Record<string, unknown> | null;
                    return meta?.month === monthLabel;
                });

                if (!alreadyWarned) {
                    const remaining = limit - taskCount;
                    await createNotification(db, 'task_limit_warning', {
                        userId,
                        context: { usage: {
                            pct, limit: limit.toLocaleString(),
                            count: taskCount.toLocaleString(), remaining: remaining.toLocaleString(),
                        }, plan: { tier_name: plan.tierName } },
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
