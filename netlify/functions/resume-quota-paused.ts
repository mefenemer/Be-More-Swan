// resume-quota-paused.ts
// Scheduled Netlify function — reverses the quota pause applied by task-volume-check.ts once the
// org is back under its monthly task allowance.
//
// Why this exists: hitting the cap used to be a one-way door. task-volume-check switched every
// assistant off and NOTHING ever switched them back on — usage_counters rolls over to a fresh
// period on the 1st (getPeriodStart), so the customer had quota again but a workspace full of dark
// assistants and no prompt to do anything about it. That reads as "the product stopped working",
// and is silent churn.
//
// Safety: only rows stamped provisioningStatus='paused_quota' are resumed. An assistant the USER
// switched off is 'complete' + isActive=false and is left alone; paused_payment / paused_limit are
// other systems' pauses and are likewise untouched. That separation is the whole reason the quota
// pause got its own status instead of overloading isActive.
//
// Schedule: configure in netlify.toml as:
//   [functions.resume-quota-paused]
//   schedule = "15 0 * * *"   # 00:15 UTC daily — just after the UTC month rolls over
//
// Runs daily rather than monthly on purpose: a mid-month upgrade raises the limit, which can put
// the org back under cap before the 1st, and the next run picks that up with no extra plumbing.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { plans, masterPlans, aiAssistants, usageCounters } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { effectiveLimit, type FeatureOverrides } from '../../src/utils/plan-features';
import { getPeriodStart } from '../../src/utils/atomic-cap-check';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const db = getDb();
        const periodStart = getPeriodStart();

        // Every org that currently has at least one quota-paused assistant. Starting from the
        // paused rows (rather than from all plans) keeps this cheap: on a normal day it is empty.
        const pausedRows = await db
            .select({
                id: aiAssistants.id,
                name: aiAssistants.name,
                userId: aiAssistants.userId,
                organisationId: aiAssistants.organisationId,
            })
            .from(aiAssistants)
            .where(and(
                eq(aiAssistants.provisioningStatus, 'paused_quota'),
                isNotNull(aiAssistants.organisationId),
            ));

        if (!pausedRows.length) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ok: true, checked: 0, resumedOrgs: 0, resumedAssistants: 0 }),
            };
        }

        // Group by org — the allowance is an org-level counter, so the decision is per org.
        const byOrg = new Map<number, typeof pausedRows>();
        for (const row of pausedRows) {
            const orgId = row.organisationId as number;
            if (!byOrg.has(orgId)) byOrg.set(orgId, []);
            byOrg.get(orgId)!.push(row);
        }

        let resumedOrgs = 0;
        let resumedAssistants = 0;

        for (const [organisationId, assistants] of byOrg) {
            // Resolve the org's live limit exactly as enforcement does (frozen overrides win).
            const [plan] = await db
                .select({
                    tierName: masterPlans.name,
                    monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                    featureOverrides: plans.featureOverrides,
                })
                .from(plans)
                .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(
                    eq(plans.organisationId, organisationId),
                    inArray(plans.status, ['active', 'past_due']),
                ))
                .limit(1);

            // No active plan → the org is paywalled for reasons this job must not paper over.
            if (!plan) continue;

            const limit = effectiveLimit(
                plan.featureOverrides as FeatureOverrides | null,
                'monthlyTaskLimit',
                plan.monthlyTaskLimit,
            );

            // Read the same counter enforcement uses. A missing row = fresh period = zero used.
            const [counter] = await db
                .select({ taskCount: usageCounters.taskCount })
                .from(usageCounters)
                .where(and(
                    eq(usageCounters.organisationId, organisationId),
                    eq(usageCounters.periodStart, periodStart),
                ))
                .limit(1);
            const used = counter?.taskCount ?? 0;

            // limit === null means the plan is uncapped (e.g. frozen as unlimited, or an upgrade to
            // an unlimited tier) — always resume. Otherwise resume only once back under the cap.
            if (limit != null && used >= limit) continue;

            const ids = assistants.map(a => a.id);
            const resumed = await db
                .update(aiAssistants)
                .set(withUpdatedAt({ isActive: true, provisioningStatus: 'complete' }))
                .where(and(
                    inArray(aiAssistants.id, ids),
                    // Re-assert the marker inside the UPDATE: if anything changed these rows
                    // between the SELECT above and here, we must not resurrect them.
                    eq(aiAssistants.provisioningStatus, 'paused_quota'),
                ))
                .returning({ id: aiAssistants.id, name: aiAssistants.name, userId: aiAssistants.userId });

            if (!resumed.length) continue;
            resumedOrgs++;
            resumedAssistants += resumed.length;

            // Tell the owner their assistants are working again — the whole point is that the user
            // should not have to notice by themselves. One notification per owning user.
            const byUser = new Map<number, string[]>();
            for (const row of resumed) {
                if (row.userId == null) continue;
                if (!byUser.has(row.userId)) byUser.set(row.userId, []);
                byUser.get(row.userId)!.push(row.name);
            }
            for (const [userId, names] of byUser) {
                await createNotification(db, 'task_limit_resumed', {
                    userId,
                    context: {
                        resumed: {
                            assistant_phrase: names.length > 1 ? 'assistants' : 'assistant',
                            verb: names.length > 1 ? 'have' : 'has',
                            names: names.join(', '),
                        },
                        plan: { tier_name: plan.tierName },
                    },
                    metadata: { organisationId, resumedCount: names.length, periodStart: periodStart.toISOString() },
                }).catch(err => console.warn('[resume-quota-paused] notify failed:', err?.message || err));
            }
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, checked: byOrg.size, resumedOrgs, resumedAssistants }),
        };

    } catch (err: any) {
        console.error('[resume-quota-paused]', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
});
