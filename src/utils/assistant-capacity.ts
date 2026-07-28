// src/utils/assistant-capacity.ts
// "May this organisation take on another assistant?" — one implementation, for every path that
// creates one.
//
// ── Why this is shared rather than checked where it is needed ───────────────────────────────────
// The rule lived inline in hire-assistant.ts and NOWHERE ELSE, while two other endpoints insert
// into ai_assistants. onboarding.ts — the one the Social Media form submits to — had no check at
// all, so an org on the £29 plan (one assistant) could be given a second simply by completing the
// onboarding form twice. The only gate on that route was in the browser
// (assistant-catalogue.html's _catHire), which the setup wizard's "Resume setup" link bypasses
// entirely, and which fails OPEN when check-capacity errors.
//
// A limit enforced only by the page that usually precedes the write is not enforced. This is the
// server-side twin of check-capacity, and it belongs next to the insert.

import { and, asc, count, eq, inArray, or } from 'drizzle-orm';
import { aiAssistants, masterPlans, organisations, plans } from '../../db/schema';
import { effectiveLimit, type FeatureOverrides } from './plan-features';

/**
 * Lifecycle states that OCCUPY a plan seat.
 *
 * Deliberately not "isActive": a newly provisioned assistant sits in ready_for_work (inactive)
 * until it is kicked off, and counting only active ones would let an org provision straight past
 * its limit. paused, system_paused and archived do not occupy a seat — which is what makes
 * archiving a workable way to free one.
 */
export const SEAT_OCCUPYING_STATUSES = ['provisioning', 'ready_for_work', 'working'] as const;

export type CapacityRefusal = {
    status: 402 | 409;
    code: 'NO_PLAN' | 'CAPACITY';
    error: string;
};

/**
 * null when another assistant may be created, or the refusal to return to the caller.
 *
 * Scoped by org OR user: an org member shares the owner's plan (keyed to the owner's userId plus
 * the org id), so a userId-only lookup finds no plan for members of a paid workspace and would
 * refuse them all.
 */
export async function checkAssistantCapacity(
    db: any,
    userId: number,
    orgId: number,
): Promise<CapacityRefusal | null> {
    const [planRow] = await db
        .select({ assistantLimit: masterPlans.assistantLimit, featureOverrides: plans.featureOverrides })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(
            or(eq(plans.userId, userId), eq(plans.organisationId, orgId)),
            inArray(plans.status, ['active', 'past_due']),
        ))
        .orderBy(asc(plans.status), asc(plans.startedAt))
        .limit(1);

    // No active/past_due plan → HARD BLOCK. The free trial was removed (product decision): a user
    // with no paid plan can hire no assistants. A missing plan used to resolve to assistantLimit
    // = null and skip the gate entirely, which granted unlimited free hires.
    if (!planRow) {
        return { status: 402, code: 'NO_PLAN', error: 'Choose a plan to hire your first assistant.' };
    }

    // Plan Features: a "new subscribers only" frozen snapshot beats the live master limit.
    let assistantLimit: number | null = effectiveLimit(
        planRow.featureOverrides as FeatureOverrides | null, 'assistantLimit', planRow.assistantLimit ?? null);
    if (assistantLimit === null) return null;   // unlimited

    const [org] = await db
        .select({ bonusAssistants: organisations.bonusAssistants })
        .from(organisations)
        .where(eq(organisations.id, orgId))
        .limit(1);
    assistantLimit += org?.bonusAssistants ?? 0;

    const [{ value: occupied }] = await db
        .select({ value: count() })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.organisationId, orgId),
            inArray(aiAssistants.lifecycleStatus, [...SEAT_OCCUPYING_STATUSES]),
        ));

    if (occupied >= assistantLimit) {
        return {
            status: 409,
            code: 'CAPACITY',
            error: "You've used all your assistant slots. Upgrade your plan to add more.",
        };
    }
    return null;
}
