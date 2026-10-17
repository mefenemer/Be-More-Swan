// src/utils/trial.ts
// The free 14-day trial — no card. Owner decisions 2026-10-17:
//   • every new workspace gets it automatically when its owner verifies their email (verify.ts);
//   • it is the £79 Busywork Buster's features — every assistant — with a 150-task allowance
//     (master_plans 'trial', db/z-trial-plan.sql; featureTierKey reads 'trial' as 'buster');
//   • on day 14 without a subscription: the trial plan expires, running assistants pause and anything
//     scheduled is held — nothing is deleted. The plan picker (check-capacity `noPlan`) is how they
//     carry on, and subscribing switches everything back on (afterPaidPlanStarted → here);
//   • one trial per workspace, and one per person (trials.organisation_id unique; user check below).
//
// Same shape as the beta ending (beta-ending.ts), which this deliberately mirrors. trial-sweep.ts runs
// it daily. Every reader used by a publish path NEVER throws: a missing table must not stop posting.

import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, masterPlans, plans, trials } from '../../db/schema';
import { FREE_PLAN_TYPES, TRIAL_TIER_KEY } from '../config/beta-plan';
import { releaseHeldWork } from './held-work';

type Db = ReturnType<typeof getDb>;

export const TRIAL_DAYS = 14;
/** plans.plan_type for a trial plan (no Stripe, no card). */
export const TRIAL_PLAN_TYPE = 'trial';
/** provisioningStatus stamped on an assistant paused because its workspace's trial ended. Only rows
 *  carrying it are switched back on — an assistant the user paused themselves is left alone. */
export const TRIAL_ENDED_PAUSE = 'paused_trial_ended';

export interface TrialStart { started: boolean; endsAt?: Date; reason?: 'no_trial_plan' | 'has_plan' | 'had_trial' }

/**
 * Start the trial for a new workspace. Idempotent and safe to call on every first verification:
 * a workspace that has ever had any plan, or a person who has ever had a trial, gets none.
 */
export async function startTrialIfEligible(
    db: Db,
    params: { userId: number; organisationId: number },
    now = new Date(),
): Promise<TrialStart> {
    const [trialPlan] = await db.select({ id: masterPlans.id, name: masterPlans.name })
        .from(masterPlans).where(eq(masterPlans.tierKey, TRIAL_TIER_KEY)).limit(1);
    if (!trialPlan) return { started: false, reason: 'no_trial_plan' };

    // Any plan row at all (paid, beta, cancelled, expired) — this workspace is not new.
    const [anyPlan] = await db.select({ id: plans.id }).from(plans)
        .where(eq(plans.organisationId, params.organisationId)).limit(1);
    if (anyPlan) return { started: false, reason: 'has_plan' };

    // One trial per person, whichever workspace they make.
    const [hadTrial] = await db.select({ id: trials.id }).from(trials)
        .where(eq(trials.userId, params.userId)).limit(1);
    if (hadTrial) return { started: false, reason: 'had_trial' };

    const endsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    return db.transaction(async (tx) => {
        const inserted = await tx.insert(trials)
            .values({ organisationId: params.organisationId, userId: params.userId, startedAt: now, endsAt })
            .onConflictDoNothing()
            .returning({ id: trials.id });
        if (!inserted.length) return { started: false, reason: 'had_trial' } as TrialStart;
        await tx.insert(plans).values({
            userId: params.userId,
            organisationId: params.organisationId,
            masterPlanId: trialPlan.id,
            planName: trialPlan.name,
            planType: TRIAL_PLAN_TYPE,
            status: 'active',
            startedAt: now,
            expiresAt: endsAt,
        });
        return { started: true, endsAt };
    });
}

/** The org's trial row, or null. Never throws (null on a missing table). */
export async function getTrial(db: Db, organisationId: number): Promise<typeof trials.$inferSelect | null> {
    try {
        const [row] = await db.select().from(trials).where(eq(trials.organisationId, organisationId)).limit(1);
        return row ?? null;
    } catch {
        return null;
    }
}

/** Whole days left, rounded up (a trial ending later today has 1 day left; an ended one 0). */
export function trialDaysLeft(endsAt: Date, now = new Date()): number {
    return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * End one workspace's trial: expire the trial plan and pause its running assistants. Idempotent.
 * A workspace that already subscribed is only marked converted.
 */
export async function endTrialFor(db: Db, organisationId: number, now = new Date()): Promise<'ended' | 'converted' | 'skipped'> {
    const [trial] = await db.select().from(trials).where(eq(trials.organisationId, organisationId)).limit(1);
    if (!trial || trial.endedAt || trial.convertedAt) return 'skipped';

    const [paid] = await db.select({ id: plans.id }).from(plans).where(and(
        eq(plans.organisationId, organisationId),
        notInArray(plans.planType, [...FREE_PLAN_TYPES]),
        inArray(plans.status, ['active', 'past_due', 'cancelling']),
    )).limit(1);
    if (paid) {
        await db.update(trials).set({ convertedAt: now, updatedAt: now }).where(eq(trials.id, trial.id));
        return 'converted';
    }

    await db.update(plans).set({ status: 'expired', updatedAt: now })
        .where(and(eq(plans.organisationId, organisationId), eq(plans.planType, TRIAL_PLAN_TYPE), eq(plans.status, 'active')));
    // Only RUNNING assistants are paused, and stamped so only they come back.
    await db.update(aiAssistants).set({ isActive: false, provisioningStatus: TRIAL_ENDED_PAUSE, updatedAt: now })
        .where(and(eq(aiAssistants.organisationId, organisationId), eq(aiAssistants.isActive, true)));
    await db.update(trials).set({ endedAt: now, updatedAt: now }).where(eq(trials.id, trial.id));
    return 'ended';
}

/**
 * After a paid plan row is written (via afterPaidPlanStarted). Marks the trial converted and, if it
 * had already ended, switches the paused assistants back on and sends held work to Review. A trial
 * still running is simply marked converted — nothing of it is held. Never throws.
 */
export async function resumeAfterTrialConversion(db: Db, organisationId: number, now = new Date()): Promise<boolean> {
    try {
        const [trial] = await db.select().from(trials).where(eq(trials.organisationId, organisationId)).limit(1);
        if (!trial || trial.convertedAt) return false;
        if (trial.endedAt) await releaseHeldWork(db, organisationId, TRIAL_ENDED_PAUSE, now);
        await db.update(trials).set({ convertedAt: now, updatedAt: now }).where(eq(trials.id, trial.id));
        return !!trial.endedAt;
    } catch (err) {
        console.error('[trial] resume after conversion failed (non-fatal)', organisationId, err);
        return false;
    }
}

/** Workspaces whose trial ended without a subscription — their publishing is held. Never throws. */
export async function endedTrialOrganisationIds(db: Db): Promise<number[]> {
    try {
        const rows = await db.select({ id: trials.organisationId }).from(trials)
            .where(and(isNotNull(trials.endedAt), isNull(trials.convertedAt)));
        return rows.map((r) => r.id);
    } catch (err) {
        console.error('[trial] could not read ended trials — publishing is NOT held for them', err);
        return [];
    }
}

/** Running trials whose end date has passed. */
export async function dueTrials(db: Db, now = new Date()): Promise<Array<typeof trials.$inferSelect>> {
    return db.select().from(trials)
        .where(and(lte(trials.endsAt, now), isNull(trials.endedAt), isNull(trials.convertedAt)));
}

/** Running trials ending within `days` that have not had their reminder yet. */
export async function trialsNeedingReminder(db: Db, days = 3, now = new Date()): Promise<Array<typeof trials.$inferSelect>> {
    const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return db.select().from(trials).where(and(
        lte(trials.endsAt, horizon), gt(trials.endsAt, now),
        isNull(trials.reminderSentAt), isNull(trials.endedAt), isNull(trials.convertedAt),
    ));
}
