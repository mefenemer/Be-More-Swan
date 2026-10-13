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
 * The lookup_key that identifies a plan's monthly GBP Price at a given amount. Exported so the
 * admin price-change path (src/utils/plan-pricing.ts) mints its Price under the SAME key this
 * resolver searches for — otherwise the two paths mint separate Price objects for the same amount
 * and a plan ends up with duplicates in the Stripe catalog.
 */
export function monthlyLookupKey(tierKey: string, unitAmountMinor: number): string {
    return `${tierKey}_monthly_gbp_${unitAmountMinor}`;
}

/**
 * Find-or-create the stable monthly GBP Price for a plan at its current master_plans amount.
 * Minted on the plan's own Stripe product (backfilled); falls back to a fresh product only if the
 * plan has no product id yet. Returns the Stripe price id.
 */
export async function resolveMonthlyPriceId(stripe: Stripe, plan: PlanForPricing): Promise<string> {
    const unitAmount = Math.round(Number(plan.monthlyPriceGbp) * 100);
    const lookupKey  = monthlyLookupKey(plan.tierKey, unitAmount);

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

// ── Annual ("Pay Annually", 20% off) ──────────────────────────────────────────────────────────────

/** The annual discount: 20% off twelve monthly payments. */
export const ANNUAL_DISCOUNT = 0.8;

/**
 * The yearly charge for a plan, in whole GBP — EXACTLY what pricing.html advertises
 * (syncLivePricesGBP: round(monthly × 0.8) per month, × 12). It used to be computed three ways:
 * checkout.html charged monthly × 12 × 0.8 unrounded (£278.40 for the £29 plan against an
 * advertised £276), the promo preview did the same, and only the in-app plan picker matched the
 * page. One function now, so the page, both checkouts and the preview cannot disagree.
 */
export function annualAmountGbp(monthlyGbp: number | string): number {
    return Math.round(Number(monthlyGbp) * ANNUAL_DISCOUNT) * 12;
}

export function annualLookupKey(tierKey: string, unitAmountMinor: number): string {
    return `${tierKey}_annual_gbp_${unitAmountMinor}`;
}

/**
 * Find-or-create the stable yearly GBP Price for a plan, on the plan's OWN product — like the
 * monthly one. Annual prices used to sit on a separate "<plan> (Annual)" product, so the nightly
 * reconciliation (which identifies a subscription's plan by its product) could not place an annual
 * subscriber, and the in-app picker minted a new product and price on every annual checkout.
 */
export async function resolveAnnualPriceId(stripe: Stripe, plan: PlanForPricing): Promise<string> {
    const unitAmount = annualAmountGbp(plan.monthlyPriceGbp) * 100;
    const lookupKey = annualLookupKey(plan.tierKey, unitAmount);

    const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    if (existing.data.length > 0) return existing.data[0].id;

    const productId = plan.stripeProductId
        ?? (await stripe.products.create({ name: plan.name, metadata: { tierKey: plan.tierKey } })).id;

    const price = await stripe.prices.create({
        currency:            'gbp',
        product:             productId,
        unit_amount:         unitAmount,
        recurring:           { interval: 'year' },
        lookup_key:          lookupKey,
        transfer_lookup_key: true,
    });
    return price.id;
}

/** The price for a plan on the given billing interval — the one call plan changes need. */
export function resolvePriceIdForInterval(stripe: Stripe, plan: PlanForPricing, interval: 'month' | 'year'): Promise<string> {
    return interval === 'year' ? resolveAnnualPriceId(stripe, plan) : resolveMonthlyPriceId(stripe, plan);
}
