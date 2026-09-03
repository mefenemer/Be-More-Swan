// src/utils/plan-stripe-refs.ts
//
// One home for "fill in the Stripe references a plan row is missing".
//
// A first subscription is written by two racers — netlify/functions/confirm-payment.ts (the
// browser landing on workspace.html?payment=success) and netlify/functions/stripe-webhook.ts
// (checkout.session.completed / payment_intent.succeeded). Exactly one of them wins
// plans_one_active_per_org_unique; the other takes a 23505. Both used to swallow that conflict
// and return 200 without ever looking at the row that already existed, so an active plan
// carrying NULL stripe ids could never be healed by either of them.
//
// That matters because admin-billing-override.ts refuses every action — upgrade_tier,
// downgrade_tier, comp_month, extend_trial, pause_subscription — unless BOTH
// stripe_customer_id and stripe_subscription_id are present on the org's active plan.
//
// The loser of the race now backfills instead. Two writers means this has to be safe in either
// order and safe to repeat (the webhook can be redelivered; the browser can revisit the
// success URL), which is what COALESCE buys: a populated column keeps its value, and a
// reference we do not hold is bound as NULL, where COALESCE(col, NULL) = col.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { plans } from '../../db/schema';

type Db = PostgresJsDatabase<Record<string, never>>;

/** The references a writer holds. Either id may be absent — the webhook and the PI metadata
 *  do not always carry the same fields. */
export type PlanRefs = {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    masterPlanIdInt?: number | null;
};

/** The statuses plans_one_active_per_org_unique actually covers. A backfill that looked only
 *  at 'active' would miss the row its own INSERT just collided with. */
export const PLAN_LIVE_STATUSES = ['active', 'past_due'] as const;

/**
 * Which references the existing row is missing AND this writer can actually supply.
 *
 * Pure, so the interleaving invariant is testable without a database or a Stripe key. A field
 * counts as missing only when the row lacks it and we hold a value: that makes the write a
 * no-op on the common path (both writers holding the same metadata) and keeps a populated id
 * safe from a writer that arrived without one.
 */
export function missingPlanRefs(existing: typeof plans.$inferSelect, refs: PlanRefs) {
    return {
        customer:     !existing.stripeCustomerId && !!refs.stripeCustomerId,
        subscription: !existing.stripeSubscriptionId && !!refs.stripeSubscriptionId,
        masterPlan:   existing.masterPlanId == null && refs.masterPlanIdInt != null,
    };
}

/** The org's live plan row — the one the unique index protects and an INSERT would collide with. */
export async function findLivePlanForOrg(db: Db, orgId: number) {
    const [row] = await db
        .select()
        .from(plans)
        .where(and(
            eq(plans.organisationId, orgId),
            inArray(plans.status, [...PLAN_LIVE_STATUSES]),
        ))
        .limit(1);
    return row;
}

/**
 * Fill in whatever the row is missing, never overwriting what it already has.
 *
 * Returns true if a write happened. When there is nothing to add it does not touch the row at
 * all, so updated_at stays meaningful as "when this plan last actually changed".
 */
export async function backfillPlanRefs(
    db: Db,
    existing: typeof plans.$inferSelect,
    refs: PlanRefs,
    source: string,
): Promise<boolean> {
    const missing = missingPlanRefs(existing, refs);
    if (!missing.customer && !missing.subscription && !missing.masterPlan) return false;

    await db.update(plans).set({
        stripeCustomerId:     sql`COALESCE(${plans.stripeCustomerId}, ${refs.stripeCustomerId ?? null})`,
        stripeSubscriptionId: sql`COALESCE(${plans.stripeSubscriptionId}, ${refs.stripeSubscriptionId ?? null})`,
        masterPlanId:         sql`COALESCE(${plans.masterPlanId}, ${refs.masterPlanIdInt ?? null})`,
        updatedAt:            new Date(),
    }).where(eq(plans.id, existing.id));

    console.warn(
        `[${source}] Backfilled Stripe refs onto plan ${existing.id} (org ${existing.organisationId}):` +
        `${missing.customer ? ' customer' : ''}${missing.subscription ? ' subscription' : ''}${missing.masterPlan ? ' masterPlan' : ''}`,
    );
    return true;
}

/**
 * The 23505 path, shared by all three conflict handlers: re-read the row the other writer just
 * created and fill in anything it could not supply. Safe when the row has vanished (a cancel
 * racing a webhook redelivery) — it simply does nothing.
 */
export async function backfillLivePlanForOrg(
    db: Db,
    orgId: number,
    refs: PlanRefs,
    source: string,
): Promise<boolean> {
    const raced = await findLivePlanForOrg(db, orgId);
    if (!raced) return false;
    return backfillPlanRefs(db, raced, refs, source);
}
