// src/utils/booking-deposits.ts — deposits for website bookings (docs/booking-plan.md phase 4).
// db/z-booking-deposits.sql. tests/booking-deposits.test.ts.
//
// A service (or class) can ask for a deposit (product-price.ts depositFor). When someone books it
// from the website and the workspace has a connected Stripe account that can take payments:
//   1. the booking is made as 'awaiting_payment', holding its time / places for HOLD_MINUTES;
//   2. they pay on a Stripe Checkout page ON THE BUSINESS'S OWN ACCOUNT (no platform fee);
//   3. the Connect webhook calls depositPaid → the booking becomes pending / confirmed and only
//      THEN is everyone told (bookings.ts announceNewBooking, by the caller);
//   4. an unpaid hold lapses at hold_expires_at — it stops counting at once, and the hourly sweep
//      tidies it to 'cancelled'. Stripe's page closes first (CHECKOUT_MINUTES), so a payment can't
//      land after the hold has gone; if one ever does, it is refunded straight away.
// Refunds (always the full deposit): the customer cancelling online (only possible before the
// notice cut-off), the owner declining or cancelling, or a cancelled class session.
//
// ⚠️ Imports nothing from bookings.ts (bookings.ts imports refundDeposit from here).

import { and, eq, lt, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { getDb } from '../../db/client';
import { bookings, orgProducts } from '../../db/schema';
import { getStripe } from './stripe';
import { connectAccountFor } from './site-shop';
import { depositFor, formatPounds } from './product-price';
import { BOOK_PATH, FORM_SENT_PATH } from './site-render';
import { signBookingId } from './booking-links';

type Db = ReturnType<typeof getDb>;
type BookingRow = typeof bookings.$inferSelect;

/** Stripe's checkout page closes after CHECKOUT_MINUTES (its minimum is 30); the hold outlasts it. */
export const CHECKOUT_MINUTES = 31;
export const HOLD_MINUTES = 35;

export const holdUntil = (now: Date) => new Date(now.getTime() + HOLD_MINUTES * 60_000);

/** The deposit a service or class asks, for `places`, if this workspace can take card payments. */
export async function depositToTake(db: Db, orgId: number, serviceId: number | null, places: number): Promise<number | null> {
    if (!serviceId) return null;
    const [p] = await db.select({ depositType: orgProducts.depositType, depositAmount: orgProducts.depositAmount, priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount })
        .from(orgProducts).where(and(eq(orgProducts.id, serviceId), eq(orgProducts.organisationId, orgId))).limit(1);
    const pence = p ? depositFor(p, places) : null;
    if (pence === null) return null;
    const account = await connectAccountFor(db, orgId);
    return account?.chargesEnabled ? pence : null;
}

/** Where "Back" on Stripe's page goes: releases the hold at once (signed like the manage link). */
export const releasePath = (bookingId: number, back: string) => `${BOOK_PATH}?release=${bookingId}&t=${signBookingId(bookingId)}&b=${encodeURIComponent(back)}`;

/** The Checkout Session for a deposit — pure, so the money rules are testable. */
export function depositCheckoutParams(p: { origin: string; booking: Pick<BookingRow, 'id' | 'organisationId' | 'siteId' | 'customerEmail'>; pence: number; what: string; when: string; backPath: string; now: Date }): Stripe.Checkout.SessionCreateParams {
    const meta = { bms_kind: 'booking_deposit', bms_booking: String(p.booking.id), bms_org: String(p.booking.organisationId), bms_site: String(p.booking.siteId ?? '') };
    return {
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'gbp', unit_amount: p.pence, product_data: { name: `Deposit — ${p.what}`.slice(0, 250), description: p.when.slice(0, 250) } } }],
        customer_email: p.booking.customerEmail,
        expires_at: Math.floor(p.now.getTime() / 1000) + CHECKOUT_MINUTES * 60,
        success_url: `${p.origin}${FORM_SENT_PATH}?k=booking&st=paid&b=${encodeURIComponent(p.backPath)}`,
        cancel_url: `${p.origin}${releasePath(p.booking.id, p.backPath)}`,
        metadata: meta,
        payment_intent_data: { metadata: meta, description: `Deposit — ${p.what}, ${p.when}`.slice(0, 500) },
    };
}

/** Start paying: a Checkout Session on the workspace's own account, remembered on the booking. */
export async function startDepositCheckout(db: Db, p: Parameters<typeof depositCheckoutParams>[0]): Promise<{ ok: true; url: string } | { ok: false }> {
    const account = await connectAccountFor(db, p.booking.organisationId);
    if (!account?.chargesEnabled) return { ok: false };
    try {
        const session = await getStripe().checkout.sessions.create(depositCheckoutParams(p), { stripeAccount: account.stripeAccountId });
        if (!session.url) throw new Error('Stripe returned no checkout address');
        await db.update(bookings).set({ checkoutSessionId: session.id }).where(eq(bookings.id, p.booking.id));
        return { ok: true, url: session.url };
    } catch (err) {
        console.error('[booking-deposits] checkout failed', { bookingId: p.booking.id, message: err instanceof Error ? err.message : String(err) });
        return { ok: false };
    }
}

/** Let go of an unpaid hold now (they came back from Stripe, or checkout couldn't start). */
export async function releaseHold(db: Db, bookingId: number): Promise<BookingRow | null> {
    const [row] = await db.update(bookings).set({ status: 'cancelled', paymentStatus: 'expired', holdExpiresAt: null, decidedAt: new Date() })
        .where(and(eq(bookings.id, bookingId), eq(bookings.status, 'awaiting_payment'))).returning();
    return row ?? null;
}

/** Hourly: unpaid holds past their time → cancelled (they already stopped counting). */
export async function sweepExpiredHolds(db: Db, now: Date): Promise<number> {
    const rows = await db.update(bookings).set({ status: 'cancelled', paymentStatus: 'expired', holdExpiresAt: null, decidedAt: now })
        .where(and(eq(bookings.status, 'awaiting_payment'), lt(bookings.holdExpiresAt, now))).returning({ id: bookings.id });
    return rows.length;
}

/**
 * The deposit was paid (Connect webhook). Checks the session is on the account that workspace
 * connected and is the one this booking started. Returns the booking when it has just become a real
 * booking (the caller then tells everyone); null for a repeat delivery or anything not ours.
 * A payment for a booking whose hold has already gone is refunded at once.
 */
export async function depositPaid(db: Db, accountId: string, session: Stripe.Checkout.Session, mode: 'instant' | 'request'): Promise<{ booking: BookingRow; lateRefund: boolean } | null> {
    if (session.metadata?.bms_kind !== 'booking_deposit' || session.payment_status !== 'paid') return null;
    const id = Number(session.metadata.bms_booking);
    if (!Number.isInteger(id)) return null;
    const [b] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    if (!b || b.checkoutSessionId !== session.id) return null;
    const account = await connectAccountFor(db, b.organisationId);
    if (!account || account.stripeAccountId !== accountId) {
        console.error('[booking-deposits] deposit paid on an account this workspace did not connect', { bookingId: id, accountId });
        return null;
    }
    const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    const instant = mode === 'instant';
    const [made] = await db.update(bookings).set({
        status: instant ? 'confirmed' : 'pending', decidedAt: instant ? new Date() : null,
        paymentStatus: 'paid', paymentIntentId: intent, holdExpiresAt: null,
    }).where(and(eq(bookings.id, id), eq(bookings.status, 'awaiting_payment'))).returning();
    if (made) return { booking: made, lateRefund: false };
    if (b.paymentStatus === 'paid' || b.paymentStatus === 'refunded') return null;   // already handled
    // Paid after the hold went: record it, and give it straight back.
    const [late] = await db.update(bookings).set({ paymentStatus: 'paid', paymentIntentId: intent }).where(eq(bookings.id, id)).returning();
    await refundDeposit(db, late);
    const [after] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    return { booking: after, lateRefund: true };
}

/** Give a paid deposit back in full (on the business's own account). Never throws. */
export async function refundDeposit(db: Db, b: Pick<BookingRow, 'id' | 'organisationId' | 'paymentStatus' | 'paymentIntentId'>): Promise<'refunded' | 'refund_failed' | 'none'> {
    if (b.paymentStatus !== 'paid' || !b.paymentIntentId) return 'none';
    try {
        const account = await connectAccountFor(db, b.organisationId);
        if (!account) throw new Error('no connected account');
        await getStripe().refunds.create({ payment_intent: b.paymentIntentId, reason: 'requested_by_customer' }, { stripeAccount: account.stripeAccountId, idempotencyKey: `deposit-refund-${b.id}` });
        await db.update(bookings).set({ paymentStatus: 'refunded' }).where(eq(bookings.id, b.id));
        return 'refunded';
    } catch (err) {
        console.error('[booking-deposits] refund failed', { bookingId: b.id, message: err instanceof Error ? err.message : String(err) });
        await db.update(bookings).set({ paymentStatus: 'refund_failed' }).where(eq(bookings.id, b.id));
        return 'refund_failed';
    }
}

/** Where a booking's money stands, in words, for emails and the owner's list. */
export function depositNote(b: Pick<BookingRow, 'depositPence' | 'paymentStatus'>): string | null {
    if (!b.depositPence) return null;
    const amount = formatPounds(b.depositPence);
    switch (b.paymentStatus) {
        case 'paid': return `${amount} deposit paid`;
        case 'refunded': return `${amount} deposit refunded`;
        case 'refund_failed': return `${amount} deposit — refund failed, please refund it in Stripe`;
        case 'unpaid': return `Waiting for the ${amount} deposit`;
        default: return null;
    }
}

/** SQL: a booking that holds its time or places right now (pending, confirmed, or an unpaid hold still in time). */
export const holdsTime = sql`(${bookings.status} IN ('pending', 'confirmed') OR (${bookings.status} = 'awaiting_payment' AND ${bookings.holdExpiresAt} > now()))`;
