// src/utils/stay-charges.ts — taking and returning money for a stay (holiday let / B&B room) on the
// business's OWN Stripe account. docs/holiday-lets-plan.md §5. tests/site-stays.test.ts.
//
// At booking the guest pays what is due now (the deposit, or everything when they book inside the
// balance window) — plus the damage deposit when they pay in full — on one Stripe Checkout page.
// It rides the deposit machinery (booking-deposits.ts): bms_kind 'booking_deposit', the same hold,
// the same webhook, the same release on "Back". What is stay-only is here:
//   · the currency is the stay's, not always pounds;
//   · with balance collection 'auto', Checkout saves the card on the business's account so the
//     balance can be charged on its due date (the guest is told on the quote and on Stripe's page);
//   · a guest cancelling gets back the % their cancellation policy gives for that many days before
//     arrival — and always all of a damage deposit taken with the payment.
//
// ⚠️ Imports nothing from bookings.ts or site-booking.ts.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { getDb } from '../../db/client';
import { bookings, stayTypes } from '../../db/schema';
import { CHECKOUT_MINUTES, releasePath } from './booking-deposits';
import { connectAccountFor } from './site-shop';
import { FORM_SENT_PATH } from './site-render';
import { nightsBetween, refundPercent, type CancellationStep, type StayQuote } from './stay-quote';
import { formatMoney } from './product-price';

const stripeClient = async () => (await import('./stripe')).getStripe();

type Db = ReturnType<typeof getDb>;
type BookingRow = typeof bookings.$inferSelect;

/** What the guest pays at booking: the stay's part, and the damage deposit when it is taken now. */
export function chargeNow(q: StayQuote): { stay: number; damage: number; total: number } {
    const damage = q.damageDepositNow ? q.damageDeposit : 0;
    return { stay: q.dueNow, damage, total: q.dueNow + damage };
}

/** The Checkout Session for paying a stay — pure, so the money rules are testable. */
export function stayCheckoutParams(p: {
    origin: string; booking: Pick<BookingRow, 'id' | 'organisationId' | 'siteId' | 'customerEmail' | 'stayTypeId'>;
    quote: StayQuote; what: string; when: string; backPath: string; now: Date;
}): Stripe.Checkout.SessionCreateParams {
    const q = p.quote;
    const c = chargeNow(q);
    const currency = q.currency.toLowerCase();
    const saveCard = q.balance > 0 && q.balanceCollection === 'auto';
    const meta = {
        bms_kind: 'booking_deposit', bms_booking: String(p.booking.id), bms_org: String(p.booking.organisationId),
        bms_site: String(p.booking.siteId ?? ''), bms_stay: String(p.booking.stayTypeId ?? ''), bms_damage_now: c.damage ? '1' : '0',
    };
    const label = q.balance > 0 ? 'Deposit' : 'Stay';
    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
        { quantity: 1, price_data: { currency, unit_amount: c.stay, product_data: { name: `${label} — ${p.what}`.slice(0, 250), description: p.when.slice(0, 250) } } },
    ];
    if (c.damage) line_items.push({ quantity: 1, price_data: { currency, unit_amount: c.damage, product_data: { name: 'Refundable damage deposit', description: 'Returned after your stay.' } } });
    return {
        mode: 'payment',
        line_items,
        customer_email: p.booking.customerEmail,
        expires_at: Math.floor(p.now.getTime() / 1000) + CHECKOUT_MINUTES * 60,
        success_url: `${p.origin}${FORM_SENT_PATH}?k=booking&st=paid&b=${encodeURIComponent(p.backPath)}`,
        cancel_url: `${p.origin}${releasePath(p.booking.id, p.backPath)}`,
        metadata: meta,
        // The balance is charged later to the same card — only when the owner chose that, and the
        // guest has been told on the quote; Stripe's page says the card is saved for this business.
        ...(saveCard ? { customer_creation: 'always' as const } : {}),
        payment_intent_data: {
            metadata: meta, description: `${label} — ${p.what}, ${p.when}`.slice(0, 500),
            ...(saveCard ? { setup_future_usage: 'off_session' as const } : {}),
        },
        ...(saveCard ? { custom_text: { submit: { message: `Your card is saved by this business to take the remaining balance on its due date.` } } } : {}),
    };
}

/** Off to Stripe. The checkout session is remembered on the booking (the webhook matches it). */
export async function startStayCheckout(db: Db, p: Parameters<typeof stayCheckoutParams>[0]): Promise<{ ok: true; url: string } | { ok: false }> {
    const account = await connectAccountFor(db, p.booking.organisationId);
    if (!account?.chargesEnabled) return { ok: false };
    try {
        const session = await (await stripeClient()).checkout.sessions.create(stayCheckoutParams(p), { stripeAccount: account.stripeAccountId });
        if (!session.url) throw new Error('Stripe returned no checkout address');
        await db.update(bookings).set({ checkoutSessionId: session.id }).where(eq(bookings.id, p.booking.id));
        return { ok: true, url: session.url };
    } catch (err) {
        console.error('[stay-charges] checkout failed', { bookingId: p.booking.id, message: err instanceof Error ? err.message : String(err) });
        return { ok: false };
    }
}

/** A stay's own setting for confirming (instant / request) — the webhook uses it instead of the business's. */
export async function stayModeFor(db: Db, stayTypeId: number): Promise<'instant' | 'request' | null> {
    const [row] = await db.select({ mode: stayTypes.mode }).from(stayTypes).where(eq(stayTypes.id, stayTypeId)).limit(1);
    return row ? (row.mode === 'instant' ? 'instant' : 'request') : null;
}

/** After the webhook marks it paid: remember the saved card's customer, and that the damage deposit is held. */
export async function stayPaymentSettled(db: Db, b: BookingRow, session: Stripe.Checkout.Session): Promise<BookingRow> {
    if (b.kind !== 'stay') return b;
    const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
    const damageNow = session.metadata?.bms_damage_now === '1';
    const [row] = await db.update(bookings).set({
        ...(customer ? { stripeCustomerId: customer } : {}),
        // The damage deposit came in this payment: it goes back on this payment too.
        ...(damageNow && b.damageDepositStatus === 'due' ? { damageDepositStatus: 'held', damagePaymentIntentId: b.paymentIntentId } : {}),
    }).where(eq(bookings.id, b.id)).returning();
    return row ?? b;
}

// ── Refunds: a stay can have taken money twice (the deposit, then the balance) ─────────────────

type MoneyRow = Pick<BookingRow, 'checkIn' | 'depositPence' | 'paymentStatus' | 'damageDepositPence' | 'damageDepositStatus' | 'balanceStatus' | 'balancePence'>;

/** What the guest has paid for the STAY itself (the damage deposit is kept apart). Pure. */
export function stayPaidSoFar(b: Pick<MoneyRow, 'depositPence' | 'paymentStatus' | 'balanceStatus' | 'balancePence'>): number {
    return (b.paymentStatus === 'paid' ? b.depositPence ?? 0 : 0) + (b.balanceStatus === 'paid' ? b.balancePence ?? 0 : 0);
}

/**
 * What a guest cancelling now gets back: the policy's % of what they paid for the stay, and all of a
 * damage deposit we are holding. Pure. `today` in the business's timezone.
 */
export function stayRefundFor(b: MoneyRow, policy: CancellationStep[], today: string): { percent: number; stay: number; damage: number; total: number } {
    const paid = stayPaidSoFar(b);
    const days = b.checkIn ? nightsBetween(today, b.checkIn) : 0;
    const percent = refundPercent(policy, days);
    const stay = Math.round(paid * percent / 100);
    const damage = b.damageDepositStatus === 'held' ? b.damageDepositPence ?? 0 : 0;
    return { percent, stay, damage, total: stay + damage };
}

type RefundRow = Pick<BookingRow, 'id' | 'paymentIntentId' | 'paymentStatus' | 'depositPence' | 'balanceStatus' | 'balancePence' | 'balancePaymentIntentId' | 'damageDepositStatus' | 'damagePaymentIntentId'>;

/**
 * Which payment each part of a refund goes back on — pure. The stay's part comes off the balance
 * payment first (the most recent), then the deposit; the damage deposit goes back on the payment that
 * took it. Never more off a payment than the stay part it carried (plus its damage deposit).
 */
export function refundPlan(b: RefundRow, stay: number, damage: number): Array<{ paymentIntent: string; amount: number }> {
    const out = new Map<string, number>();
    const add = (pi: string | null, n: number) => { if (pi && n > 0) out.set(pi, (out.get(pi) ?? 0) + n); };
    let left = stay;
    if (b.balanceStatus === 'paid') { const n = Math.min(left, b.balancePence ?? 0); add(b.balancePaymentIntentId, n); left -= n; }
    if (b.paymentStatus === 'paid') add(b.paymentIntentId, Math.min(left, b.depositPence ?? 0));
    if (damage > 0 && b.damageDepositStatus === 'held') add(b.damagePaymentIntentId, damage);
    return [...out.entries()].map(([paymentIntent, amount]) => ({ paymentIntent, amount }));
}

/**
 * Give money back for a stay, on the business's own account. Never throws. `why` names the refund so a
 * retry can't pay twice (Stripe idempotency). The damage deposit is marked returned when part of it.
 */
export async function refundStayParts(db: Db, b: RefundRow & Pick<BookingRow, 'organisationId'>, stay: number, damage: number, why: string): Promise<'refunded' | 'refund_failed' | 'none'> {
    const plan = refundPlan(b, stay, damage);
    if (!plan.length) return 'none';
    try {
        const account = await connectAccountFor(db, b.organisationId);
        if (!account) throw new Error('no connected account');
        const stripe = await stripeClient();
        for (const p of plan) {
            await stripe.refunds.create({ payment_intent: p.paymentIntent, amount: p.amount, reason: 'requested_by_customer' },
                { stripeAccount: account.stripeAccountId, idempotencyKey: `stay-${why}-${b.id}-${p.paymentIntent}` });
        }
        // Only what was actually refunded changes: a payment left alone keeps its status.
        const touched = (pi: string | null) => !!pi && plan.some((p) => p.paymentIntent === pi);
        await db.update(bookings).set({
            ...(stay > 0 && b.paymentStatus === 'paid' && touched(b.paymentIntentId) ? { paymentStatus: 'refunded' } : {}),
            ...(stay > 0 && b.balanceStatus === 'paid' && touched(b.balancePaymentIntentId) ? { balanceStatus: 'refunded' } : {}),
            ...(damage > 0 ? { damageDepositStatus: 'returned', damageDecidedAt: new Date() } : {}),
        }).where(eq(bookings.id, b.id));
        return 'refunded';
    } catch (err) {
        console.error('[stay-charges] refund failed', { bookingId: b.id, why, message: err instanceof Error ? err.message : String(err) });
        await db.update(bookings).set({
            // Shown to the owner as "refund failed, please refund it in Stripe" (depositNote).
            ...(stay > 0 ? { paymentStatus: 'refund_failed' } : {}),
            ...(damage > 0 ? { damageDepositStatus: 'refund_failed' } : {}),
        }).where(eq(bookings.id, b.id));
        return 'refund_failed';
    }
}

/**
 * The owner declined or cancelled a stay: everything comes back — the deposit (refunded in full by the
 * usual path in bookings.ts decideBooking), and here the balance and damage deposit if they were paid.
 */
export async function refundStayRest(db: Db, b: BookingRow): Promise<void> {
    if (b.kind !== 'stay') return;
    const balance = b.balanceStatus === 'paid' ? b.balancePence ?? 0 : 0;
    // A damage deposit taken with the deposit went back with it (a full refund of that payment).
    const damageElsewhere = b.damageDepositStatus === 'held' && b.damagePaymentIntentId && b.damagePaymentIntentId !== b.paymentIntentId ? b.damageDepositPence ?? 0 : 0;
    if (balance || damageElsewhere) {
        await refundStayParts(db, { ...b, paymentStatus: 'none' }, balance, damageElsewhere, 'owner-cancel');
    }
    if (b.damageDepositStatus === 'held' && !damageElsewhere) {
        await db.update(bookings).set({ damageDepositStatus: 'returned', damageDecidedAt: new Date() }).where(eq(bookings.id, b.id));
    }
    // Nothing more will be asked for.
    if (b.balanceStatus === 'due') await db.update(bookings).set({ balanceStatus: 'none' }).where(eq(bookings.id, b.id));
}

// ── The balance ───────────────────────────────────────────────────────────────────────────────

/** What collecting the balance charges: the balance, plus the damage deposit when it wasn't taken yet. Pure. */
export function balanceCharge(b: Pick<BookingRow, 'balancePence' | 'damageDepositPence' | 'damageDepositStatus'>): { balance: number; damage: number; total: number } {
    const balance = b.balancePence ?? 0;
    const damage = b.damageDepositStatus === 'due' ? b.damageDepositPence ?? 0 : 0;
    return { balance, damage, total: balance + damage };
}

const balanceMeta = (b: Pick<BookingRow, 'id' | 'organisationId'>, damage: number) => ({
    bms_kind: 'stay_balance', bms_booking: String(b.id), bms_org: String(b.organisationId), bms_damage: damage ? '1' : '0',
});

/** The Checkout Session behind the guest's "pay the balance" link — pure. */
export function balanceCheckoutParams(p: { origin: string; booking: Pick<BookingRow, 'id' | 'organisationId' | 'customerEmail' | 'currency' | 'balancePence' | 'damageDepositPence' | 'damageDepositStatus'>; what: string; when: string; backPath: string; now: Date }): Stripe.Checkout.SessionCreateParams {
    const c = balanceCharge(p.booking);
    const currency = (p.booking.currency || 'GBP').toLowerCase();
    const meta = balanceMeta(p.booking, c.damage);
    const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
        { quantity: 1, price_data: { currency, unit_amount: c.balance, product_data: { name: `Balance — ${p.what}`.slice(0, 250), description: p.when.slice(0, 250) } } },
    ];
    if (c.damage) line_items.push({ quantity: 1, price_data: { currency, unit_amount: c.damage, product_data: { name: 'Refundable damage deposit', description: 'Returned after your stay.' } } });
    return {
        mode: 'payment', line_items, customer_email: p.booking.customerEmail,
        expires_at: Math.floor(p.now.getTime() / 1000) + CHECKOUT_MINUTES * 60,
        success_url: `${p.origin}${FORM_SENT_PATH}?k=booking&st=balance&b=${encodeURIComponent(p.backPath)}`,
        cancel_url: `${p.origin}${p.backPath}`,
        metadata: meta,
        payment_intent_data: { metadata: meta, description: `Balance — ${p.what}, ${p.when}`.slice(0, 500) },
    };
}

export async function startBalanceCheckout(db: Db, p: Parameters<typeof balanceCheckoutParams>[0]): Promise<{ ok: true; url: string } | { ok: false }> {
    const account = await connectAccountFor(db, p.booking.organisationId);
    if (!account?.chargesEnabled) return { ok: false };
    try {
        const session = await (await stripeClient()).checkout.sessions.create(balanceCheckoutParams(p), { stripeAccount: account.stripeAccountId });
        if (!session.url) throw new Error('Stripe returned no checkout address');
        await db.update(bookings).set({ balanceCheckoutSessionId: session.id }).where(eq(bookings.id, p.booking.id));
        return { ok: true, url: session.url };
    } catch (err) {
        console.error('[stay-charges] balance checkout failed', { bookingId: p.booking.id, message: err instanceof Error ? err.message : String(err) });
        return { ok: false };
    }
}

/** Record the balance as paid (and the damage deposit as held when it came with it). Only from 'due'. */
async function markBalancePaid(db: Db, id: number, paymentIntent: string | null, damage: boolean): Promise<BookingRow | null> {
    const [row] = await db.update(bookings).set({
        balanceStatus: 'paid', balancePaymentIntentId: paymentIntent,
        ...(damage ? { damageDepositStatus: 'held', damagePaymentIntentId: paymentIntent } : {}),
    }).where(and(eq(bookings.id, id), inArray(bookings.balanceStatus, ['due', 'failed']))).returning();
    return row ?? null;
}

/**
 * The owner chose "charge automatically": the balance (and damage deposit) off the card saved at
 * booking, without the guest present. A card that needs the guest (3-D Secure) or is declined returns
 * ok:false — the caller then sends the pay link and tells the owner.
 */
export async function chargeBalanceOffSession(db: Db, b: BookingRow): Promise<{ ok: true; booking: BookingRow } | { ok: false; reason: string }> {
    if (!b.stripeCustomerId) return { ok: false, reason: 'no saved card' };
    const account = await connectAccountFor(db, b.organisationId);
    if (!account?.chargesEnabled) return { ok: false, reason: 'Stripe is not connected' };
    const c = balanceCharge(b);
    try {
        const stripe = await stripeClient();
        const opts = { stripeAccount: account.stripeAccountId };
        const methods = await stripe.paymentMethods.list({ customer: b.stripeCustomerId, type: 'card', limit: 1 }, opts);
        const pm = methods.data[0];
        if (!pm) return { ok: false, reason: 'no saved card' };
        const intent = await stripe.paymentIntents.create({
            amount: c.total, currency: (b.currency || 'GBP').toLowerCase(), customer: b.stripeCustomerId, payment_method: pm.id,
            off_session: true, confirm: true, metadata: balanceMeta(b, c.damage), description: `Balance — booking ${b.id}`,
        }, { ...opts, idempotencyKey: `stay-balance-${b.id}` });
        if (intent.status !== 'succeeded') return { ok: false, reason: `the card needs the guest (${intent.status})` };
        const row = await markBalancePaid(db, b.id, intent.id, c.damage > 0);
        return row ? { ok: true, booking: row } : { ok: false, reason: 'already settled' };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[stay-charges] balance charge failed', { bookingId: b.id, message: msg });
        return { ok: false, reason: 'the card was declined' };
    }
}

/**
 * The guest paid the balance from their link (Connect webhook, bms_kind 'stay_balance'). Checks it is
 * this booking's own session on the account that workspace connected. Null for a repeat or anything
 * not ours.
 */
export async function stayBalancePaid(db: Db, accountId: string, session: Stripe.Checkout.Session): Promise<BookingRow | null> {
    if (session.metadata?.bms_kind !== 'stay_balance' || session.payment_status !== 'paid') return null;
    const id = Number(session.metadata.bms_booking);
    if (!Number.isInteger(id)) return null;
    const [b] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    if (!b || b.balanceCheckoutSessionId !== session.id) return null;
    const account = await connectAccountFor(db, b.organisationId);
    if (!account || account.stripeAccountId !== accountId) {
        console.error('[stay-charges] balance paid on an account this workspace did not connect', { bookingId: id, accountId });
        return null;
    }
    const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
    return markBalancePaid(db, id, intent, session.metadata.bms_damage === '1');
}

// ── The damage deposit ────────────────────────────────────────────────────────────────────────

/** The owner keeps `keep` of the damage deposit (0 = all of it back). Pure check. */
export function cleanKeep(held: number, keep: number, reason: string): { ok: true } | { ok: false; error: string } {
    if (!Number.isInteger(keep) || keep < 0) return { ok: false, error: 'How much are you keeping? For example 40.' };
    if (keep > held) return { ok: false, error: 'That is more than the damage deposit.' };
    if (keep > 0 && reason.trim().length < 5) return { ok: false, error: 'Say why you are keeping it — the guest is sent your reason.' };
    return { ok: true };
}

/** Give back the damage deposit, keeping `keep` (minor units) with a reason. Never throws. */
export async function settleDamageDeposit(db: Db, b: BookingRow, keep: number, reason: string | null): Promise<'returned' | 'part_kept' | 'refund_failed' | 'none'> {
    if (b.damageDepositStatus !== 'held' || !b.damageDepositPence) return 'none';
    const back = b.damageDepositPence - keep;
    // Claim it first, so the hourly return and an owner's click can't both refund.
    const [claimed] = await db.update(bookings).set({ damageDecidedAt: new Date() })
        .where(and(eq(bookings.id, b.id), eq(bookings.damageDepositStatus, 'held'), isNull(bookings.damageDecidedAt))).returning({ id: bookings.id });
    if (!claimed) return 'none';
    if (back > 0) {
        const r = await refundStayParts(db, b, 0, back, keep ? 'damage-part' : 'damage');
        if (r !== 'refunded') return 'refund_failed';
    }
    const status = keep > 0 ? 'part_kept' : 'returned';
    await db.update(bookings).set({ damageDepositStatus: status, damageDepositKeptPence: keep || null, damageDepositKeptReason: keep ? reason : null }).where(eq(bookings.id, b.id));
    return status;
}

// ── What the owner's Bookings tab shows about a stay's money ──────────────────────────────────

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The balance and damage deposit in plain words, and what the owner can do now. Pure. */
export function stayMoneyView(b: BookingRow, now: Date): { balance: string | null; balanceProblem: boolean; damage: string | null; damageHeld: boolean; canKeep: boolean; damageAmount: string | null } {
    const cur = b.currency || 'GBP';
    const m = (n: number) => formatMoney(n, cur);
    const today = now.toISOString().slice(0, 10);
    const bal = b.balancePence ?? 0;
    const how = b.balanceCollection === 'auto' ? 'card charged automatically' : 'payment link emailed';
    const balance = !bal || b.balanceStatus === 'none' ? null
        : b.balanceStatus === 'paid' ? `Balance ${m(bal)} paid`
        : b.balanceStatus === 'refunded' ? `Balance ${m(bal)} refunded`
        : b.balanceStatus === 'failed' ? `Balance ${m(bal)} — the card was declined; payment link emailed`
        : b.balanceRequestedAt ? `Balance ${m(bal)} due — not paid yet${b.balanceRemindedAt ? ' (reminded)' : ''}`
        : `Balance ${m(bal)} due ${b.balanceDueOn ? shortDay(b.balanceDueOn) : ''} (${how})`;
    const dmg = b.damageDepositPence ?? 0;
    const kept = b.damageDepositKeptPence ?? 0;
    const damage = !dmg || b.damageDepositStatus === 'none' ? null : {
        due: `Damage deposit ${m(dmg)} — taken with the balance`,
        held: `Damage deposit ${m(dmg)} held${b.damageDepositReturnOn ? ` — goes back by itself on ${shortDay(b.damageDepositReturnOn)}` : ''}`,
        returned: `Damage deposit ${m(dmg)} returned`,
        part_kept: `Damage deposit: kept ${m(kept)}, returned ${m(dmg - kept)}${b.damageDepositKeptReason ? ` — "${b.damageDepositKeptReason}"` : ''}`,
        refund_failed: `Damage deposit ${m(dmg)} — the refund failed; please refund it in Stripe`,
    }[b.damageDepositStatus || ''] ?? null;
    const held = b.damageDepositStatus === 'held';
    return {
        balance, balanceProblem: b.balanceStatus === 'failed' || (b.balanceStatus === 'due' && !!b.balanceRemindedAt),
        damage, damageHeld: held, canKeep: held && !!b.checkIn && b.checkIn <= today,
        damageAmount: held ? (dmg / 100).toFixed(2).replace(/\.00$/, '') : null,
    };
}
