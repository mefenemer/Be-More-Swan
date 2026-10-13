// src/utils/billed-mrr.ts
// What a subscription ACTUALLY bills per month, after discounts — for the COGS margin.
//
// The COGS dashboard used to credit each workspace with its plan's LIST price. Three prod workspaces
// on 100%-off comp coupons therefore showed £79–£349 of revenue and a 99–100% margin; once founding
// members (30% off) arrive, every one of them would read as more profitable than it is. This reads
// the subscription from Stripe and applies its discounts the same way the billing page does
// (summariseDiscount), so "margin" means margin.

import type Stripe from 'stripe';
import { summariseDiscount, DISCOUNT_EXPANDS } from './billing-doc';

export interface BilledMonthly {
    /** GBP per month actually billed (annual ÷ 12), after discounts. */
    monthlyGbp: number;
    /** e.g. "FOUNDER30 30% off", or null with no discount. */
    discount: string | null;
    interval: 'month' | 'year';
}

/** Pure: the monthly billed amount for a subscription object (discounts expanded). */
export function billedMonthlyFromSubscription(sub: {
    items?: { data?: Array<{ quantity?: number | null; price?: { unit_amount?: number | null; currency?: string | null; recurring?: { interval?: string | null } | null } | null }> };
    discounts?: unknown[] | null;
}): BilledMonthly {
    const items = sub.items?.data ?? [];
    const grossMinor = items.reduce((sum, i) => sum + (i.price?.unit_amount ?? 0) * (i.quantity ?? 1), 0);
    const interval = items[0]?.price?.recurring?.interval === 'year' ? 'year' : 'month';
    const v = summariseDiscount((sub.discounts ?? []) as any[], grossMinor, items[0]?.price?.currency ?? 'gbp');
    const netMinor = v ? Math.round(v.netAmount * 100) : grossMinor;
    const perMonth = interval === 'year' ? netMinor / 12 : netMinor;
    return {
        monthlyGbp: Math.round(perMonth) / 100,
        discount: v ? `${v.codes[0] ?? v.name ?? 'discount'} ${v.label}` : null,
        interval,
    };
}

/**
 * Billed monthly amount per subscription id, read from Stripe in parallel. Missing or failed reads
 * are simply absent from the map — the caller falls back to the list price and says so.
 */
export async function billedMonthlyBySubscription(stripe: Stripe, subscriptionIds: string[]): Promise<Map<string, BilledMonthly>> {
    const out = new Map<string, BilledMonthly>();
    await Promise.all([...new Set(subscriptionIds)].map(async (id) => {
        try {
            const sub = await stripe.subscriptions.retrieve(id, { expand: DISCOUNT_EXPANDS });
            if (['active', 'trialing', 'past_due'].includes(sub.status)) out.set(id, billedMonthlyFromSubscription(sub as any));
        } catch (err) {
            console.warn('[billed-mrr] could not read subscription', id, (err as Error)?.message);
        }
    }));
    return out;
}
