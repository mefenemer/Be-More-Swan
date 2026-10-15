// tests/booking-deposits.test.ts
// Deposits for website bookings (docs/booking-plan.md phase 4): set per service (fixed £ or % of a
// fixed price, per place for a class), paid on the business's own Stripe account while the time is
// held, announced only once paid, refunded in full when cancelled in time or by the business.
// src/utils/product-price.ts, booking-deposits.ts, bookings.ts, site-booking.ts, site-classes.ts.
//
// Run:  npx tsx tests/booking-deposits.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-deposits';

import { cleanDeposit, depositFor, depositLabel } from '../src/utils/product-price';
import { CHECKOUT_MINUTES, depositCheckoutParams, depositNote, HOLD_MINUTES, holdUntil } from '../src/utils/booking-deposits';
import { signBookingId } from '../src/utils/booking-links';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const fixed45 = { priceType: 'fixed', priceAmount: 4500 };

console.log('\nSetting a deposit');

check('a fixed £ amount (in pounds as typed) — at least 30p, never more than the price', () => {
    assert.deepStrictEqual(cleanDeposit({ depositType: 'fixed', depositAmount: '£10' }, fixed45), { depositType: 'fixed', depositAmount: 1000 });
    assert.ok('error' in cleanDeposit({ depositType: 'fixed', depositAmount: '0.20' }, fixed45));
    assert.ok('error' in cleanDeposit({ depositType: 'fixed', depositAmount: '50' }, fixed45));
    assert.deepStrictEqual(cleanDeposit({ depositType: 'fixed', depositAmount: 15 }, { priceType: 'from', priceAmount: 4500 }), { depositType: 'fixed', depositAmount: 1500 }, 'a "from" price can still take a fixed deposit');
});
check('a percentage needs a fixed price, is 1–100, and must come to at least 30p', () => {
    assert.deepStrictEqual(cleanDeposit({ depositType: 'percent', depositAmount: '20%' }, fixed45), { depositType: 'percent', depositAmount: 20 });
    assert.ok('error' in cleanDeposit({ depositType: 'percent', depositAmount: 20 }, { priceType: 'on_request', priceAmount: null }));
    assert.ok('error' in cleanDeposit({ depositType: 'percent', depositAmount: 0 }, fixed45));
    assert.ok('error' in cleanDeposit({ depositType: 'percent', depositAmount: 1 }, { priceType: 'fixed', priceAmount: 2000 }), '1% of £20 is 20p');
    assert.deepStrictEqual(cleanDeposit({ depositType: '' }, fixed45), { depositType: null, depositAmount: null });
});
check('what it comes to: per booking, or per place for a class', () => {
    assert.strictEqual(depositFor({ depositType: 'fixed', depositAmount: 1000, ...fixed45 }), 1000);
    assert.strictEqual(depositFor({ depositType: 'fixed', depositAmount: 500, ...fixed45 }, 3), 1500);
    assert.strictEqual(depositFor({ depositType: 'percent', depositAmount: 20, ...fixed45 }), 900);
    assert.strictEqual(depositFor({ depositType: 'percent', depositAmount: 20, priceType: 'text', priceAmount: null }), null, 'the price stopped being fixed → no deposit');
    assert.strictEqual(depositFor({ depositType: null, depositAmount: null, ...fixed45 }), null);
    assert.strictEqual(depositLabel({ depositType: 'fixed', depositAmount: 1000, ...fixed45 }), '£10 deposit');
    assert.strictEqual(depositLabel({ depositType: 'fixed', depositAmount: 550, ...fixed45 }, true), '£5.50 deposit per place');
});

console.log('\nPaying it');

const booking = { id: 77, organisationId: 9, siteId: 3, customerEmail: 'sam@example.com' };
const now = new Date('2026-10-20T10:00:00Z');

check('the checkout: the deposit only, on their email, closing before the hold does', () => {
    const p = depositCheckoutParams({ origin: 'https://willowbrook.bemoreswan.site', booking, pence: 1000, what: 'Cut & finish with Elena', when: 'Friday 23 October, 10am–11am', backPath: '/book', now });
    assert.strictEqual(p.mode, 'payment');
    assert.strictEqual(p.line_items![0].price_data!.unit_amount, 1000);
    assert.strictEqual(p.line_items![0].price_data!.currency, 'gbp');
    assert.strictEqual(p.line_items![0].price_data!.product_data!.name, 'Deposit — Cut & finish with Elena');
    assert.strictEqual(p.customer_email, 'sam@example.com');
    assert.strictEqual(p.expires_at, Math.floor(now.getTime() / 1000) + CHECKOUT_MINUTES * 60);
    assert.ok(CHECKOUT_MINUTES >= 30 && HOLD_MINUTES > CHECKOUT_MINUTES, 'Stripe\'s minimum is 30 minutes; the hold outlasts the page');
    assert.strictEqual(holdUntil(now).getTime() - now.getTime(), HOLD_MINUTES * 60_000);
    assert.deepStrictEqual(p.metadata, { bms_kind: 'booking_deposit', bms_booking: '77', bms_org: '9', bms_site: '3' });
    assert.strictEqual(p.success_url, 'https://willowbrook.bemoreswan.site/_sent?k=booking&st=paid&b=%2Fbook');
    assert.strictEqual(p.cancel_url, `https://willowbrook.bemoreswan.site/_book?release=77&t=${signBookingId(77)}&b=%2Fbook`, 'back from Stripe releases the hold, signed');
    assert.ok(!('application_fee_amount' in (p.payment_intent_data || {})), 'no platform fee');
});
check('a hold counts as taken only while in time; nobody is told until it is paid', () => {
    const dep = read('src/utils/booking-deposits.ts');
    assert.ok(dep.includes("(${bookings.status} = 'awaiting_payment' AND ${bookings.holdExpiresAt} > now())"));
    assert.ok(read('src/utils/bookings.ts').includes('.where(and(eq(bookings.organisationId, orgId), holdsTime, gte(bookings.startsAt, from)'));
    assert.ok(read('src/utils/class-sessions.ts').includes('.where(and(inArray(bookings.sessionId, ids), holdsTime))'));
    const sb = read('src/utils/site-booking.ts');
    const pay = sb.indexOf("if (made.booking.status === 'awaiting_payment' && deposit) return payDeposit(");
    const announce = sb.indexOf('await announceNewBooking(b.db, made.booking', pay);
    assert.ok(pay > 0 && announce > pay, 'pay first, announce only for a booking without a deposit');
    const wh = read('netlify/functions/stripe-connect-webhook.ts');
    assert.ok(wh.includes("if (session.metadata?.bms_kind === 'booking_deposit') await depositSettled(db, evt.account, session);"));
    assert.ok(read('src/utils/site-shop.ts').includes("if (session.metadata?.bms_kind === 'booking_deposit') return false;"), 'never recorded as a shop order');
});
check('the payment is checked: this booking\'s own session, on the account that workspace connected', () => {
    const dep = read('src/utils/booking-deposits.ts');
    assert.ok(dep.includes('if (!b || b.checkoutSessionId !== session.id) return null;'));
    assert.ok(dep.includes('if (!account || account.stripeAccountId !== accountId)'));
    assert.ok(dep.includes(".where(and(eq(bookings.id, id), eq(bookings.status, 'awaiting_payment'))).returning();"), 'only a live hold becomes a booking');
    assert.ok(dep.includes('await refundDeposit(db, late);'), 'a payment after the hold went is given back');
});
check('tables never take a deposit; it is mentioned only where Stripe can take it', () => {
    const sb = read('src/utils/site-booking.ts');
    assert.ok(sb.includes("const deposit = props.kind === 'table' ? null : await depositToTake("));
    assert.ok(read('src/utils/booking-deposits.ts').includes('return account?.chargesEnabled ? pence : null;'));
    assert.ok(read('src/utils/bookings.ts').includes('deposit: takes ? depositLabel(s) : null'));
});

console.log('\nRefunds');

check('refunded in full: the customer cancelling online, the business declining or cancelling, a cancelled class date', () => {
    const sb = read('src/utils/site-booking.ts');
    const refund = sb.indexOf("if (done && done.paymentStatus === 'paid') done.paymentStatus = await refundDeposit(b.db, done)");
    const told = sb.indexOf("await emailCustomer(done, 'cancelled_by_you'", refund);
    assert.ok(refund > 0 && told > refund, 'refund, then tell them');
    assert.ok(read('src/utils/bookings.ts').includes("if (action !== 'confirm' && row.paymentStatus === 'paid') row.paymentStatus = await refundDeposit(db, row)"));
    assert.ok(read('netlify/functions/sites.ts').includes("if (b.status === 'cancelled' && b.paymentStatus === 'paid') b.paymentStatus = await refundDeposit(db, b)"));
    const dep = read('src/utils/booking-deposits.ts');
    assert.ok(dep.includes('idempotencyKey: `deposit-refund-${b.id}`') && dep.includes('{ stripeAccount: account.stripeAccountId'), 'on their own account, once');
});
check('a moved booking keeps the deposit it already paid', () => {
    assert.ok(read('src/utils/bookings.ts').includes('...(moved?.depositPence ? { depositPence: moved.depositPence, paymentStatus: moved.paymentStatus, paymentIntentId: moved.paymentIntentId } : {})'));
});
check('in words, for emails and the owner', () => {
    assert.strictEqual(depositNote({ depositPence: 1000, paymentStatus: 'paid' }), '£10 deposit paid');
    assert.strictEqual(depositNote({ depositPence: 1000, paymentStatus: 'refunded' }), '£10 deposit refunded');
    assert.ok(/refund failed/.test(depositNote({ depositPence: 1000, paymentStatus: 'refund_failed' })!));
    assert.strictEqual(depositNote({ depositPence: null, paymentStatus: null }), null);
});

console.log('\nTidying and data');

check('unpaid holds are tidied hourly; back from Stripe lets the hold go at once', () => {
    assert.ok(read('netlify/functions/send-booking-reminders.ts').includes('await sweepExpiredHolds(getDb(), new Date())'));
    const sb = read('src/utils/site-booking.ts');
    assert.ok(sb.includes("if (q.get('release'))") && sb.includes("verifyBookingToken(id, String(q.get('t') || ''))") && sb.includes("row.status === 'awaiting_payment') await releaseHold(b.db, id);"));
});
check('the SQL is re-run safe and keeps one booking per checkout', () => {
    const s = read('db/z-booking-deposits.sql');
    assert.ok(s.includes("AND pg_get_constraintdef(oid) LIKE '%awaiting_payment%'"));
    assert.ok(s.includes('CREATE UNIQUE INDEX IF NOT EXISTS bookings_checkout_session_uq'));
    assert.ok(s.includes("(deposit_type = 'percent' AND deposit_amount BETWEEN 1 AND 100)"));
});
check('Business Information sets it; the chat explains it', () => {
    const ui = read('assets.html');
    assert.ok(ui.includes('id="op-deposit-type"') && ui.includes("depositType: get('op-deposit-type') || null, depositAmount: get('op-deposit-amount')"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('DEPOSITS: a service or class can ask for a deposit'));
});

console.log(`\n${passed}/${total} passed\n`);
