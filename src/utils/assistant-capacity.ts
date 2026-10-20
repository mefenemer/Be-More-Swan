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

import { and, asc, count, eq, gte, inArray, ne, or } from 'drizzle-orm';
import { aiAssistants, auditLogs, masterAssistants, masterPlans, organisations, plans } from '../../db/schema';
import { effectiveLimit, type FeatureOverrides } from './plan-features';
import { getPeriodStart } from './atomic-cap-check';

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

// ── Role switches: one per billing month on capped plans ────────────────────────────────────────
// Owner, 2026-10-20: "Limit Tier 1 to one assistant role change per billing month." Archiving
// frees a seat, so without this a one-assistant plan could rotate through every role in the
// catalogue — the £69 plan's whole point — one at a time.
//
// The rule, per billing period (= the calendar month, 1st 00:00 UTC — the same period the task
// allowance resets on, getPeriodStart(); plans carries no Stripe period dates to read instead):
//   • HELD = the roles the org had at the start of the period: any assistant created before it and
//     not archived at that moment (working, ready, paused and system-paused all count).
//   • NEW  = the roles brought in during the period that are not HELD — hired, or reinstated from
//     an archive. Counted once per role: hiring X, archiving it and getting X back is one change.
//   • The org may bring in (seats empty at the start of the period) + 1 NEW roles. The empty seats
//     cover a first hire — an org with nothing is not swapping — and the +1 is the switch.
//   • A role already HELD or already NEW is never refused: reinstating the role you started the
//     month with, or pausing and resuming any assistant, is not a change.
//   • Uncapped plans (assistantLimit null — Tier 2) and orgs with no plan are not limited here.
// Counted from ai_assistants and the lifecycle audit trail; there is no ledger table.
//
// ⚠️ The pricing FAQ states this rule. Change the copy if you change the rule.

export type RoleSwapRefusal = { status: 409; code: 'SWAP_LIMIT'; error: string; nextSwitchAt: string };

export type RoleSwapRow = {
    id: number;
    roleKey: string;
    createdAt: Date;
    archivedAt: Date | null;
    lifecycleStatus: string;
};

/** Lifecycle audit events in the period, oldest first, as far as role switching cares. */
export type RoleSwapEvent = { assistantId: number; kind: 'archive' | 'reinstate' };

/** Pure: may the org bring `incomingRoleKey` in this period? */
export function roleSwapAllowed(input: {
    limit: number;
    periodStart: Date;
    rows: RoleSwapRow[];
    events: RoleSwapEvent[];
    incomingRoleKey: string;
}): boolean {
    const { limit, periodStart, rows, events, incomingRoleKey } = input;
    const start = periodStart.getTime();

    const firstEvent = new Map<number, RoleSwapEvent['kind']>();
    const reinstated = new Set<number>();
    for (const e of events) {
        if (!firstEvent.has(e.assistantId)) firstEvent.set(e.assistantId, e.kind);
        if (e.kind === 'reinstate') reinstated.add(e.assistantId);
    }

    // Was this assistant on the team when the period began? Reinstating clears archivedAt, so for
    // anything archived or reinstated this period the first event says which side of it we're on.
    const heldAtStart = (r: RoleSwapRow) => {
        if (r.createdAt.getTime() >= start) return false;
        const first = firstEvent.get(r.id);
        if (first) return first === 'archive';
        if (r.archivedAt) return r.archivedAt.getTime() >= start;
        return r.lifecycleStatus !== 'archived';   // archived before archivedAt existed
    };

    const held = new Set(rows.filter(heldAtStart).map((r) => r.roleKey));
    const brought = new Set(
        rows.filter((r) => r.createdAt.getTime() >= start || reinstated.has(r.id))
            .map((r) => r.roleKey)
            .filter((k) => !held.has(k)),
    );

    if (held.has(incomingRoleKey) || brought.has(incomingRoleKey)) return true;
    const allowance = Math.max(0, limit - held.size) + 1;
    return brought.size + 1 <= allowance;
}

/** The first moment of the period after `periodStart` — when the next switch opens. */
export function nextPeriodStart(periodStart: Date): Date {
    return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
}

export function swapLimitMessage(nextSwitchAt: Date): string {
    const date = nextSwitchAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `On your plan you can switch to a different assistant once a month. Your next switch is available on ${date}. Upgrade to run every assistant at once.`;
}

/**
 * null when the org may bring this role in (hire, or reinstate from an archive), or the refusal.
 * `incoming` is the catalogue roleKey being hired, or the archived assistant being reinstated.
 * Callers run it AFTER the capacity check: at capacity the user must free a seat first, and the
 * capacity refusal says so.
 */
export async function checkRoleSwap(
    db: any,
    userId: number,
    orgId: number,
    incoming: string | { assistantId: number },
    periodStart: Date = getPeriodStart(),
): Promise<RoleSwapRefusal | null> {
    const limit = await resolveSeatLimit(db, userId, orgId);
    if (limit === 'NO_PLAN' || limit === null) return null;

    const raw: Array<{
        id: number; masterRoleKey: string | null; configuration: unknown; name: string | null;
        createdAt: Date; archivedAt: Date | null; lifecycleStatus: string; provisioningStatus: string | null;
    }> = await db
        .select({
            id: aiAssistants.id,
            masterRoleKey: masterAssistants.roleKey,
            configuration: aiAssistants.configuration,
            name: aiAssistants.name,
            createdAt: aiAssistants.createdAt,
            archivedAt: aiAssistants.archivedAt,
            lifecycleStatus: aiAssistants.lifecycleStatus,
            provisioningStatus: aiAssistants.provisioningStatus,
        })
        .from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(eq(aiAssistants.organisationId, orgId));

    // Abandoned pre-payment rows never ran — they are neither a role held nor a role brought in.
    const rows: RoleSwapRow[] = raw
        .filter((r) => !['pending', 'pending_payment'].includes(r.provisioningStatus || ''))
        .map((r) => ({
            id: r.id,
            // Same identity hire-assistant's one-per-role check uses: the master link, then
            // configuration.type, then the name for legacy rows.
            roleKey: r.masterRoleKey
                || ((r.configuration as { type?: string } | null)?.type)
                || `name:${(r.name || '').toLowerCase()}`,
            createdAt: new Date(r.createdAt),
            archivedAt: r.archivedAt ? new Date(r.archivedAt) : null,
            lifecycleStatus: r.lifecycleStatus,
        }));

    let events: RoleSwapEvent[] = [];
    if (rows.length) {
        const audit: Array<{ resourceId: string; actionType: string; newState: unknown }> = await db
            .select({ resourceId: auditLogs.resourceId, actionType: auditLogs.actionType, newState: auditLogs.newState })
            .from(auditLogs)
            .where(and(
                eq(auditLogs.resourceType, 'ai_assistants'),
                inArray(auditLogs.resourceId, rows.map((r) => String(r.id))),
                inArray(auditLogs.actionType, ['assistant_lifecycle_archived', 'assistant_lifecycle_paused']),
                gte(auditLogs.createdAt, periodStart),
            ))
            .orderBy(asc(auditLogs.createdAt));
        events = audit.flatMap((a): RoleSwapEvent[] => {
            if (a.actionType === 'assistant_lifecycle_archived') return [{ assistantId: Number(a.resourceId), kind: 'archive' }];
            return (a.newState as { reason?: string } | null)?.reason === 'user_reinstate'
                ? [{ assistantId: Number(a.resourceId), kind: 'reinstate' }]
                : [];
        });
    }

    const incomingRoleKey = typeof incoming === 'string'
        ? incoming
        : rows.find((r) => r.id === incoming.assistantId)?.roleKey;
    if (!incomingRoleKey) return null;

    if (roleSwapAllowed({ limit, periodStart, rows, events, incomingRoleKey })) return null;
    const next = nextPeriodStart(periodStart);
    return { status: 409, code: 'SWAP_LIMIT', error: swapLimitMessage(next), nextSwitchAt: next.toISOString() };
}
