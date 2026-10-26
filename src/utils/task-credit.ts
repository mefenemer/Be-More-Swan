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
import { checkFairUse, type FairUseKind } from './fair-use';
import { isUnifiedTaskMetering } from './task-metering-flag';

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
    const plan = await resolveTaskLimit(db, organisationId);

    // No plan at all → paywall. Without this, a no-plan org resolves to limit=null and
    // atomicCapCheck would wave every task through as "unlimited".
    if (!plan.hasPlan) {
        return { allowed: false, limitMessage: NO_PLAN_MESSAGE };
    }

    return atomicCapCheck({
        organisationId,
        counterKey: 'taskCount',
        limit: plan.limit,
        increment,
    });
}

export interface InteractionResult extends TaskCreditResult {
    /** Refused because the workspace has no active plan. The Business Mentor still answers then, in
     *  help-only mode (docs/business-mentor-plan.md §2.7, chat-orchestrator.ts). */
    noPlan?: boolean;
    /** Refused by the daily fair-use limit — NOT a plan limit. Never answer this with a paywall. */
    fairUse?: boolean;
}

const NO_PLAN_MESSAGE = 'Choose a plan to activate your assistant and start running tasks.';

/**
 * Meter a chat message or an editing-helper click.
 *
 * Under the single task allowance ('unified_task_metering', docs/task-metering.md) these cost no
 * tasks: the org needs a paid plan, and the click counts against a daily fair-use limit. With the
 * flag off this is exactly consumeTaskCredit — one task, up front, fails closed.
 *
 * Callers branch on three outcomes: `failed` (503, try again), `fairUse` (429 with `limitMessage`,
 * "come back tomorrow"), anything else not allowed (the upgrade/paywall response).
 */
export async function meterInteraction(
    db: Db,
    organisationId: number,
    kind: FairUseKind,
): Promise<InteractionResult> {
    if (!(await isUnifiedTaskMetering(organisationId))) return consumeTaskCredit(db, organisationId);

    let hasPlan: boolean;
    try {
        hasPlan = (await resolveTaskLimit(db, organisationId)).hasPlan;
    } catch (err) {
        console.error('[task-credit] plan lookup failed', { organisationId, message: err instanceof Error ? err.message : String(err) });
        return { allowed: false, failed: true, limitMessage: 'We could not check your plan just now. Please try again.' };
    }
    if (!hasPlan) return { allowed: false, noPlan: true, limitMessage: NO_PLAN_MESSAGE };

    const fair = await checkFairUse(db, organisationId, kind);
    if (!fair.allowed) return { allowed: false, fairUse: true, limitMessage: fair.message };
    return { allowed: true };
}

/**
 * The org's monthly task limit. `hasPlan: false` = no active/past_due plan at all; `limit: null` =
 * a legitimately uncapped paid tier. Shared with src/utils/work-metering.ts so chat and background
 * work are held to the same number.
 */
export async function resolveTaskLimit(db: Db, organisationId: number): Promise<{ hasPlan: boolean; limit: number | null }> {
    const [plan] = await db
        .select({ monthlyTaskLimit: masterPlans.monthlyTaskLimit, featureOverrides: plans.featureOverrides })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, organisationId), inArray(plans.status, ['active', 'past_due'])))
        // 'active' sorts before 'past_due', so an active plan always wins.
        .orderBy(asc(plans.status), asc(plans.startedAt))
        .limit(1);
    if (!plan) return { hasPlan: false, limit: null };
    return {
        hasPlan: true,
        // Plan Features: prefer a "new subscribers only" frozen snapshot over the live master limit.
        limit: effectiveLimit(plan.featureOverrides as FeatureOverrides | null, 'monthlyTaskLimit', plan.monthlyTaskLimit ?? null),
    };
}
