// src/utils/plan-change-schedule.ts
//
// The ONE way a subscription is moved to another plan at renewal. Used by a customer's own
// downgrade (billing-downgrade.ts) and by Admin → Revenue → Plan moves (admin-plan-moves.ts).
//
// A Stripe subscription schedule does the switch: phase 0 is the current price until the change,
// phase 1 the new price from then on. When phase 1 starts, its metadata lands on the subscription
// and stripe-webhook.ts (customer.subscription.updated) switches our plans row.
//
// ⚠️ DISCOUNTS (found 2026-10-19). The downgrade used to rebuild both phases from their items alone.
// A phase with no `discounts` does not keep a coupon attached to the subscription (Stripe only
// inherits a CUSTOMER-level discount), so a customer on a 100%-off or founding coupon could lose it
// the day their downgrade started. Every phase here carries the subscription's own discounts, by
// id, so a 12-month coupon keeps counting down from where it is.
//
// Owner decisions for moves (2026-10-19): a move starts at the customer's next renewal; a price RISE
// starts no sooner than 30 days after it was scheduled (Terms 6.6) — the first renewal on or after
// that date.

import type Stripe from 'stripe';
import { resolvePriceIdForInterval, type PlanForPricing } from './stripe-price';

export type BillingInterval = 'month' | 'year';
export type MoveDirection = 'up' | 'down' | 'same';

/** Notice the Terms promise before a customer pays more (6.6). */
export const PRICE_RISE_NOTICE_DAYS = 30;

export function moveDirection(currentPence: number | null, targetPence: number): MoveDirection {
    if (currentPence == null) return 'same';
    return targetPence > currentPence ? 'up' : targetPence < currentPence ? 'down' : 'same';
}

/** The earliest moment the change may start. A rise waits out the notice; anything else, now. */
export function earliestStart(direction: MoveDirection, now: Date): Date {
    return direction === 'up' ? new Date(now.getTime() + PRICE_RISE_NOTICE_DAYS * 86_400_000) : now;
}

/** `date` moved on by `n` billing intervals (UTC, day clamped to the month's last day). */
export function addIntervals(date: Date, interval: BillingInterval, n: number): Date {
    const d = new Date(date.getTime());
    const day = d.getUTCDate();
    d.setUTCDate(1);
    if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + n);
    else d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
}

/**
 * How many billing periods phase 0 runs (≥ 1): the first renewal on or after `notBefore`.
 * `periodEnd` is the current period's end — renewal number 1.
 */
export function periodsBeforeChange(periodEnd: Date, interval: BillingInterval, notBefore: Date): number {
    let k = 1;
    while (addIntervals(periodEnd, interval, k - 1).getTime() < notBefore.getTime() && k < 60) k++;
    return k;
}

/** A schedule phase's discounts, as params that reuse the SAME discount objects. */
export function keepDiscounts(discounts: ReadonlyArray<{ coupon?: unknown; discount?: unknown; promotion_code?: unknown }> | null | undefined) {
    const id = (v: unknown) => (typeof v === 'string' ? v : (v as { id?: string } | null)?.id) || null;
    const out: Array<{ discount?: string; coupon?: string; promotion_code?: string }> = [];
    for (const d of discounts ?? []) {
        const discount = id(d.discount);
        const promo = id(d.promotion_code);
        const coupon = id(d.coupon);
        if (discount) out.push({ discount });
        else if (promo) out.push({ promotion_code: promo });
        else if (coupon) out.push({ coupon });
    }
    return out;
}

export interface ScheduledChange {
    scheduleId: string;
    effectiveAt: Date;
    targetPriceId: string;
    interval: BillingInterval;
}

/**
 * Schedule a subscription's move to `target` at the first renewal on or after `notBefore`, keeping
 * its discounts. Releases any schedule already on the subscription first (a subscription owns at
 * most one) — callers that must not overwrite one check `sub.schedule` before calling. On any
 * failure after the schedule exists it is released again, so the subscription is left as it was.
 */
export async function schedulePlanChange(stripe: Stripe, args: {
    subscriptionId: string;
    target: PlanForPricing;
    notBefore: Date;
    /** Copied onto the subscription when the new phase starts — what the webhook reads. */
    phaseMetadata: Record<string, string>;
    scheduleMetadata?: Record<string, string>;
}): Promise<ScheduledChange> {
    const sub = await stripe.subscriptions.retrieve(args.subscriptionId, { expand: ['items'] });
    const item = sub.items.data[0];
    if (!item) throw new Error('The subscription has no item to change.');
    const interval: BillingInterval = item.price?.recurring?.interval === 'year' ? 'year' : 'month';
    const targetPriceId = await resolvePriceIdForInterval(stripe, args.target, interval);

    if (typeof sub.schedule === 'string') {
        await stripe.subscriptionSchedules.release(sub.schedule).catch(() => { /* already released */ });
    }

    const schedule = await stripe.subscriptionSchedules.create({ from_subscription: args.subscriptionId });
    try {
        const phase0 = schedule.phases[0];
        const discounts = keepDiscounts(phase0.discounts as any);
        const items0 = phase0.items.map((i) => ({
            price: typeof i.price === 'string' ? i.price : i.price.id,
            quantity: i.quantity ?? 1,
        }));
        const build = (periods: number): Stripe.SubscriptionScheduleUpdateParams => ({
            end_behavior: 'release',
            phases: [
                {
                    items: items0,
                    start_date: phase0.start_date,
                    ...(periods === 1 ? { end_date: phase0.end_date } : { duration: { interval, interval_count: periods } }),
                    ...(discounts.length ? { discounts } : {}),
                },
                {
                    items: [{ price: targetPriceId, quantity: item.quantity ?? 1 }],
                    proration_behavior: 'none',
                    metadata: args.phaseMetadata,
                    ...(discounts.length ? { discounts } : {}),
                },
            ],
            ...(args.scheduleMetadata ? { metadata: args.scheduleMetadata } : {}),
        });

        let periods = periodsBeforeChange(new Date(phase0.end_date * 1000), interval, args.notBefore);
        let updated = await stripe.subscriptionSchedules.update(schedule.id, build(periods));
        // Our calendar arithmetic is an estimate of Stripe's; Stripe's own date is the truth. If it
        // lands before the notice ends, run phase 0 one period longer.
        if (updated.phases[1] && updated.phases[1].start_date * 1000 < args.notBefore.getTime()) {
            periods += 1;
            updated = await stripe.subscriptionSchedules.update(schedule.id, build(periods));
        }
        const startUnix = updated.phases[1]?.start_date ?? updated.phases[0].end_date;
        return { scheduleId: schedule.id, effectiveAt: new Date(startUnix * 1000), targetPriceId, interval };
    } catch (err) {
        await stripe.subscriptionSchedules.release(schedule.id).catch(() => { /* best effort */ });
        throw err;
    }
}
