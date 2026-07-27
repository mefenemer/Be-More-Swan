// src/utils/task-credit.ts
// Consume one task credit from an org's monthly allowance.
//
// Extracted from chat-orchestrator.ts, which owned the only correct implementation. Anything that
// spends a model call on a user's behalf must go through here, or the plan's task cap silently
// stops being a cap — see [task cap is a hard stop]: it is never an overage charge, so an unmetered
// caller is not "extra revenue", it is free compute the plan never sold.
//
// The quality reviewer's assisted-rewrite path is the reason this moved: it is one button that can
// be clicked indefinitely, each click costing a model call, and it was charging nothing.

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { masterPlans, plans } from '../../db/schema';
import { atomicCapCheck } from './atomic-cap-check';
import { effectiveLimit, type FeatureOverrides } from './plan-features';

type Db = ReturnType<typeof getDb>;

export interface TaskCreditResult {
    allowed: boolean;
    newValue?: number;
    limitMessage?: string;
    /** Server fault, not a plan limit — see AtomicCapCheckResult.failed. Never answer this with a paywall. */
    failed?: boolean;
}

/**
 * Resolve the org's monthly task limit from its plan (active preferred, then past_due — a lapsed
 * plan keeps its limits through the grace window, mirroring check-capacity.ts) and atomically
 * consume `increment` credits.
 *
 * No active/past_due plan = HARD BLOCK: the free trial was removed (product decision), so an org
 * with no paid plan can run no tasks at all — a null limit no longer means unlimited. A master plan
 * whose monthlyTaskLimit is null is still a legitimately uncapped paid tier.
 *
 * The credit is spent up-front; a later provider failure does not refund it (same semantics as
 * task_runs).
 */
export async function consumeTaskCredit(
    db: Db,
    organisationId: number,
    increment = 1,
): Promise<TaskCreditResult> {
    const [plan] = await db
        .select({ monthlyTaskLimit: masterPlans.monthlyTaskLimit, featureOverrides: plans.featureOverrides })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, organisationId), inArray(plans.status, ['active', 'past_due'])))
        // 'active' sorts before 'past_due', so an active plan always wins.
        .orderBy(asc(plans.status), asc(plans.startedAt))
        .limit(1);

    // No plan at all → paywall. Without this, a no-plan org resolves to limit=null and
    // atomicCapCheck would wave every task through as "unlimited".
    if (!plan) {
        return { allowed: false, limitMessage: 'Choose a plan to activate your assistant and start running tasks.' };
    }

    return atomicCapCheck({
        organisationId,
        counterKey: 'taskCount',
        // Plan Features: prefer a "new subscribers only" frozen snapshot over the live master limit.
        limit: effectiveLimit(plan.featureOverrides as FeatureOverrides | null, 'monthlyTaskLimit', plan.monthlyTaskLimit ?? null),
        increment,
    });
}
