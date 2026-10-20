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

import { and, asc, count, eq, inArray, ne, or } from 'drizzle-orm';
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
 * The seat limit the org's plan grants (bonus seats included). 'NO_PLAN' when there is no
 * active/past_due plan; null when the plan is uncapped.
 *
 * Scoped by org OR user: an org member shares the owner's plan (keyed to the owner's userId plus
 * the org id), so a userId-only lookup finds no plan for members of a paid workspace and would
 * refuse them all.
 */
async function resolveSeatLimit(db: any, userId: number, orgId: number): Promise<number | null | 'NO_PLAN'> {
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
    if (!planRow) return 'NO_PLAN';

    // Plan Features: a "new subscribers only" frozen snapshot beats the live master limit.
    const limit: number | null = effectiveLimit(
        planRow.featureOverrides as FeatureOverrides | null, 'assistantLimit', planRow.assistantLimit ?? null);
    if (limit === null) return null;   // unlimited

    const [org] = await db
        .select({ bonusAssistants: organisations.bonusAssistants })
        .from(organisations)
        .where(eq(organisations.id, orgId))
        .limit(1);
    return limit + (org?.bonusAssistants ?? 0);
}

/**
 * null when another assistant may be created, or the refusal to return to the caller.
 */
export async function checkAssistantCapacity(
    db: any,
    userId: number,
    orgId: number,
): Promise<CapacityRefusal | null> {
    const assistantLimit = await resolveSeatLimit(db, userId, orgId);

    // No active/past_due plan → HARD BLOCK. The free trial was removed (product decision): a user
    // with no paid plan can hire no assistants. A missing plan used to resolve to assistantLimit
    // = null and skip the gate entirely, which granted unlimited free hires.
    if (assistantLimit === 'NO_PLAN') {
        return { status: 402, code: 'NO_PLAN', error: 'Choose a plan to hire your first assistant.' };
    }
    if (assistantLimit === null) return null;

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

/**
 * May this assistant go back INTO a seat? null when it may, or the refusal.
 *
 * ── Why resuming needs its own check ────────────────────────────────────────────────────────
 * paused / system_paused do not occupy a seat, so pausing frees one — and nothing re-checked the
 * limit on the way back. On a one-assistant plan: hire A, pause A, hire B, pause B, hire C, then
 * kick off A and B → three working on a plan that sells one. Every route that moves an assistant
 * from a non-occupying state into a seat-occupying one (kickoff-assistant.ts, manage-assistant's
 * legacy `resume`, connection-recovery's automatic restore) must ask this first.
 *
 * The assistant being resumed is excluded from the count, so an assistant already in a seat is
 * always allowed (and a call from a seat-occupying state short-circuits).
 *
 * A missing plan does NOT refuse here: that is the hire gate's rule, and applying it to resumes
 * would switch off paying customers whose plan row is missing (a known data vector) rather than
 * close this loophole. With no plan nobody can hire, so there is nothing to multiply.
 */
export async function checkResumeCapacity(
    db: any,
    userId: number,
    orgId: number,
    assistantId: number,
    fromStatus: string,
): Promise<CapacityRefusal | null> {
    if ((SEAT_OCCUPYING_STATUSES as readonly string[]).includes(fromStatus)) return null;

    const limit = await resolveSeatLimit(db, userId, orgId);
    if (limit === 'NO_PLAN' || limit === null) return null;

    const others: Array<{ id: number; name: string | null }> = await db
        .select({ id: aiAssistants.id, name: aiAssistants.name })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.organisationId, orgId),
            inArray(aiAssistants.lifecycleStatus, [...SEAT_OCCUPYING_STATUSES]),
            ne(aiAssistants.id, assistantId),
        ));

    if (others.length < limit) return null;
    return { status: 409, code: 'CAPACITY', error: resumeRefusalMessage(limit, others.map((o) => o.name || 'another assistant')) };
}

/** "Your plan runs one assistant at a time. Pause or archive Sam first, or upgrade your plan." */
export function resumeRefusalMessage(limit: number, occupantNames: string[]): string {
    const names = occupantNames.length > 3 ? [...occupantNames.slice(0, 3), 'another'] : [...occupantNames];
    if (!names.length) names.push('another assistant');
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
    if (limit <= 1) {
        return `Your plan runs one assistant at a time. Pause or archive ${list} first, or upgrade your plan.`;
    }
    return `Your plan runs ${limit} assistants at a time. Pause or archive ${names.length > 1 ? 'one of ' : ''}${list} first, or upgrade your plan.`;
}
