// src/utils/shop-first-order-flow.ts — "First order" email flows (online shop Phase 2, slice 4b; feature request #35,
// docs/online-shop-review-plan.md §12). tests/shop-first-order-flow.test.ts, tests/shop-first-order-flow-db.test.ts.
//
// A buyer who ticked "Send me news" on the basket page (slice 4a, shop-buyer-audience.ts) and has just paid:
//   • FIRST paid order at this shop, and a "first order" flow is ON → that flow starts for them. It REPLACES the
//     welcome flow for a buyer this tick just subscribed (two series on the same day reads as spam — the same rule
//     as a form linked to a flow, newsletter-sequence.ts enrolAfterSignup).
//   • otherwise, if this tick just subscribed them → the "everyone who subscribes" flow, as any new sign-up gets.
//   • otherwise nothing: an existing subscriber placing a second order is not re-welcomed.
// Never for a buyer who didn't tick, or whose address refuses email (they never reach here: addShopBuyerToAudience
// returns 'already' with a refused status, and only a subscribed contact is enrolled).
//
// "First" = no other order from the same email address at this workspace before this one, whatever became of it
// (an earlier refunded order still means they have bought before). Best effort, like every enrolment: a failure is
// logged and the order is unaffected. The unique (sequence, contact) index makes a repeat a no-op.

import { and, asc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { newsletterSequences } from '../../db/schema';
import { enrolInSequence, enrolInWelcomeSequence } from './newsletter-sequence';
import type { BuyerAudienceResult } from './shop-buyer-audience';

type Db = ReturnType<typeof getDb>;

/** The newsletter_sequences.trigger_event of a flow a buyer's first order starts. */
export const FIRST_ORDER_TRIGGER = 'first_order';

/** Every trigger at most ONE flow of which may be on per workspace (each has a partial unique index). */
export const ONE_ON_TRIGGERS = ['subscribed', FIRST_ORDER_TRIGGER] as const;

/** Who a flow goes to, in the owner's words. Pure; the Email Studio and the Email Flows tab say the same. */
export function flowAudienceWords(triggerEvent: string): string {
    return triggerEvent === 'subscribed' ? 'Everyone who subscribes'
        : triggerEvent === FIRST_ORDER_TRIGGER ? 'Shop buyers who ask for news, after their first order'
            : 'People who fill in a linked sign-up form';
}

export type FirstOrderEnrolment = 'first_order' | 'welcome' | 'none';

/** Was this the first order from this email address at this workspace? */
export async function isFirstOrder(db: Db, o: { organisationId: number; email: string; orderId: number }): Promise<boolean> {
    const r = await db.execute(sql`
        SELECT 1 FROM site_orders
         WHERE organisation_id = ${o.organisationId} AND lower(customer_email) = lower(${o.email}) AND id < ${o.orderId}
         LIMIT 1`);
    const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? []);
    return rows.length === 0;
}

/** Which flow, if any, the buyer joins. Pure. */
export function chooseBuyerFlow(o: { subscribed: boolean; newlySubscribed: boolean; firstOrder: boolean; firstOrderFlowOn: boolean }): FirstOrderEnrolment {
    if (!o.subscribed) return 'none';
    if (o.firstOrder && o.firstOrderFlowOn) return 'first_order';
    return o.newlySubscribed ? 'welcome' : 'none';
}

/** Start the right flow for a buyer who ticked the box and has paid. Never throws. */
export async function enrolShopBuyer(db: Db, o: { organisationId: number; email: string | null; orderId: number; audience: BuyerAudienceResult | null }): Promise<FirstOrderEnrolment> {
    try {
        const a = o.audience;
        if (!a || a.result === 'no_email' || !o.email) return 'none';
        const subscribed = a.result === 'added' || a.status === 'subscribed';
        if (!subscribed) return 'none';
        const email = o.email.trim().toLowerCase();
        const [flow] = await db.select({ id: newsletterSequences.id }).from(newsletterSequences)
            .where(and(eq(newsletterSequences.organisationId, o.organisationId), eq(newsletterSequences.triggerEvent, FIRST_ORDER_TRIGGER), eq(newsletterSequences.isEnabled, true)))
            .orderBy(asc(newsletterSequences.createdAt)).limit(1);
        const firstOrder = flow ? await isFirstOrder(db, { organisationId: o.organisationId, email, orderId: o.orderId }) : false;
        const choice = chooseBuyerFlow({ subscribed, newlySubscribed: a.result === 'added', firstOrder, firstOrderFlowOn: !!flow });
        const base = { organisationId: o.organisationId, contactId: a.contactId, email };
        if (choice === 'first_order') {
            const r = await enrolInSequence(db, { ...base, sequenceId: flow!.id, via: 'shop' });
            if (r.enrolled) return 'first_order';
            // review #903: the first-order flow couldn't take them (no enabled emails, a failure) — a buyer this tick
            // just subscribed still gets the welcome flow, as they would with no first-order flow at all.
            if (a.result !== 'added') return 'none';
        }
        if (choice === 'welcome' || choice === 'first_order') {
            const r = await enrolInWelcomeSequence(db, base);
            return r.enrolled ? 'welcome' : 'none';
        }
        return 'none';
    } catch (err) {
        console.error('[shop-first-order-flow] enrolment failed (the order is unaffected)', { orderId: o.orderId, message: err instanceof Error ? err.message : String(err) });
        return 'none';
    }
}
