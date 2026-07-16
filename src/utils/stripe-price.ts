// src/utils/stripe-price.ts
// Single place that turns a master_plans row into a live monthly GBP Stripe Price id.
//
// Every billing path that needs a monthly price — new checkout (create-subscription), mid-cycle
// upgrade (billing-upgrade), and any future one — resolves it here, so they all track the amount
// set in the Admin → Plans tab (master_plans.monthly_price_gbp). There are NO hardcoded price IDs
// to drift: the Price is found-or-created by a lookup_key that encodes tier + cycle + amount, so a
// price change is picked up transparently (new amount → new key → new Price), and repeated calls
// (reloads, promo re-applies) reuse the same Price instead of littering the catalog.

import type Stripe from 'stripe';

export interface PlanForPricing {
    tierKey: string;
    name: string;
    monthlyPriceGbp: string | number;
    stripeProductId: string | null;
}

/**
 * Find-or-create the stable monthly GBP Price for a plan at its current master_plans amount.
 * Minted on the plan's own Stripe product (backfilled); falls back to a fresh product only if the
 * plan has no product id yet. Returns the Stripe price id.
 */
export async function resolveMonthlyPriceId(stripe: Stripe, plan: PlanForPricing): Promise<string> {
    const unitAmount = Math.round(Number(plan.monthlyPriceGbp) * 100);
    const lookupKey  = `${plan.tierKey}_monthly_gbp_${unitAmount}`;

    const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    if (existing.data.length > 0) return existing.data[0].id;

    const productId = plan.stripeProductId
        ?? (await stripe.products.create({ name: plan.name, metadata: { tierKey: plan.tierKey } })).id;

    const price = await stripe.prices.create({
        currency:            'gbp',
        product:             productId,
        unit_amount:         unitAmount,
        recurring:           { interval: 'month' },
        lookup_key:          lookupKey,
        transfer_lookup_key: true,
    });
    return price.id;
}
