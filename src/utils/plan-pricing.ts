// src/utils/plan-pricing.ts
// Single source of truth for applying a subscription price change across DB + Stripe.
//
// Used by both the immediate path (master-data-api.ts → "plan-price-change" / master-plans
// PATCH) and the scheduled activation worker (activate-scheduled-prices.ts) so the two never
// diverge. "Applying" a price means promoting a plan_price_history row to the live price:
//   1. Mint a NEW Stripe recurring price under the shared monthly lookup_key, promote it to the
//      product's default_price, and archive the old one (legacy subs keep billing on it).
//   2. Close the current live history row (effective_to = now, status = 'superseded').
//   3. Promote the target history row (status = 'active', stripe_price_id = new, effective_to = null).
//   4. Update master_plans.monthly_price_gbp + the GBP plan_prices row so checkout + the plan
//      gate read the new price.
//
// GBP-only today (the request scope); the currency arg is threaded through for later use.
// Stripe work runs FIRST so a Stripe failure leaves the DB untouched (matches the existing
// pattern in master-data-api.ts).

import type Stripe from 'stripe';
import { and, eq, ne } from 'drizzle-orm';
import { masterPlans, planPrices, planPriceHistory } from '../../db/schema';
import { monthlyLookupKey } from './stripe-price';
import { triggerBlueprintRecompile } from './trigger-blueprint-recompile';

// `db` is a drizzle instance (getDb()); typed loosely to avoid import cycles, matching the
// convention in the other src/utils helpers.
type Db = any;

export interface ApplyPlanPriceArgs {
    plan: { id: number; tierKey: string; stripeProductId: string | null };
    currency: string;                    // 'GBP'
    newPriceGbp: number | string;        // major units, e.g. 29 or '29.00'
    historyRowId: number;                // plan_price_history row to promote to 'active'
    interval?: 'month' | 'year';         // Stripe recurring interval; defaults to 'month'
}

/**
 * Promote a plan_price_history row to the live price and sync DB + Stripe.
 * Returns the newly minted Stripe price id (null when Stripe is not configured).
 */
export async function applyPlanPrice(
    db: Db,
    stripe: Stripe | null,
    { plan, currency, newPriceGbp, historyRowId, interval = 'month' }: ApplyPlanPriceArgs,
): Promise<{ stripePriceId: string | null }> {
    const priceNum = Number(newPriceGbp);
    const now = new Date();

    // The Stripe price currently pointed at by the live plan_prices row (to archive).
    const [livePrice] = await db.select().from(planPrices)
        .where(and(eq(planPrices.masterPlanId, plan.id), eq(planPrices.currency, currency))).limit(1);

    // 1. Stripe first — mint the new price, promote it, archive the old.
    let newStripePriceId: string | null = null;
    if (stripe && plan.stripeProductId) {
        const unitAmount = Math.round(priceNum * 100);
        // Mint under the SAME lookup_key resolveMonthlyPriceId searches for, so the checkout path
        // (plan_prices.stripe_price_id) and the subscription path (lookup_key) converge on one
        // Price. Without this they each mint their own Price at the same amount.
        // transfer_lookup_key moves the key off whichever Price currently holds it.
        const created = await stripe.prices.create({
            product: plan.stripeProductId,
            unit_amount: unitAmount,
            currency: currency.toLowerCase(),
            recurring: { interval },
            ...(currency === 'GBP' && interval === 'month'
                ? { lookup_key: monthlyLookupKey(plan.tierKey, unitAmount), transfer_lookup_key: true }
                : {}),
        });
        newStripePriceId = created.id;
        // Promote it to the product's default. Nothing in this codebase reads default_price, but
        // the Stripe dashboard shows it as "Default" and anything created by hand there (payment
        // links, manual subscriptions) picks it up — so leaving it on the OLD price is a trap.
        await stripe.products.update(plan.stripeProductId, { default_price: created.id }).catch(() => {});
        // Archiving is best-effort and only possible when we know the outgoing Price. Before
        // plan_prices was populated this was null, which is why an old Price can still be active.
        if (livePrice?.stripePriceId && livePrice.stripePriceId !== created.id) {
            await stripe.prices.update(livePrice.stripePriceId, { active: false }).catch(() => {});
        }
    }

    // 2. Close the current live history row(s) for this plan+currency (excluding the target).
    await db.update(planPriceHistory)
        .set({ effectiveTo: now, status: 'superseded' })
        .where(and(
            eq(planPriceHistory.masterPlanId, plan.id),
            eq(planPriceHistory.currency, currency),
            eq(planPriceHistory.status, 'active'),
            ne(planPriceHistory.id, historyRowId),
        ));

    // 3. Promote the target row to live.
    await db.update(planPriceHistory)
        .set({ status: 'active', effectiveTo: null, stripePriceId: newStripePriceId ?? livePrice?.stripePriceId ?? null })
        .where(eq(planPriceHistory.id, historyRowId));

    // 4. Update the live price rows read by checkout + the plan gate. GBP mirrors master_plans.
    if (currency === 'GBP') {
        await db.update(masterPlans).set({ monthlyPriceGbp: String(priceNum) }).where(eq(masterPlans.id, plan.id));
    }
    await db.insert(planPrices)
        .values({
            masterPlanId: plan.id,
            currency,
            monthlyPriceMajorUnit: String(priceNum),
            stripePriceId: newStripePriceId ?? livePrice?.stripePriceId ?? null,
            isActive: true,
        })
        .onConflictDoUpdate({
            target: [planPrices.masterPlanId, planPrices.currency],
            set: {
                monthlyPriceMajorUnit: String(priceNum),
                stripePriceId: newStripePriceId ?? livePrice?.stripePriceId ?? null,
                isActive: true,
            },
        });

    // 5. The price is now live. Every path that changes a price (immediate edit, plan-price-change,
    //    and the scheduled-activation worker) converges here, so this is the one place that fires a
    //    platform-wide blueprint recompile. Awaited but best-effort — it only pokes the background
    //    worker (202 in ms) and never throws, so a recompile hiccup can't undo the applied price.
    await triggerBlueprintRecompile(`price_change:plan_${plan.id}`);

    return { stripePriceId: newStripePriceId };
}
