// tests/stay-jobs.test.ts — a stay's money after booking (docs/holiday-lets-plan.md §5): collecting the
// balance (automatic charge or pay link, reminders, the owner told), the damage deposit (returned by
// itself, or part kept by the owner with a reason), and refunds across the two payments a stay can take.
//
// Run:  npx tsx tests/stay-jobs.test.ts

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-stay-jobs';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { balanceCharge, balanceCheckoutParams, cleanKeep, refundPlan, stayMoneyView, stayPaidSoFar } from '../src/utils/stay-charges';
import { arrivalEmail, balancePayUrl, payLinkEmail } from '../src/utils/stay-jobs';
import type { BookingRow } from '../src/utils/bookings';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const B = (o: Partial<BookingRow> = {}): BookingRow => ({
    id: 41, organisationId: 9, siteId: 3, kind: 'stay', status: 'confirmed', customerName: 'Sam', customerEmail: 'sam@x.test', serviceName: 'Seaview Cottage',
    checkIn: '2027-03-05', checkOut: '2027-03-08', partySize: 2, rooms: 1, currency: 'GBP',
    depositPence: 10000, paymentStatus: 'paid', paymentIntentId: 'pi_dep',
    balancePence: 30000, balanceStatus: 'due', balanceDueOn: '2027-02-05', balanceCollection: 'link', balancePaymentIntentId: null,
    damageDepositPence: 15000, damageDepositStatus: 'due', damagePaymentIntentId: null, damageDepositReturnOn: '2027-03-15',
    damageDepositKeptPence: null, damageDepositKeptReason: null, balanceRequestedAt: null, balanceRemindedAt: null,
    startsAt: new Date('2027-03-05T16:00:00Z'), endsAt: new Date('2027-03-08T10:00:00Z'),
    ...o,
} as unknown as BookingRow);

console.log('\nthe balance');

check('collecting the balance takes the damage deposit too, when it wasn\'t taken at booking', () => {
    assert.deepStrictEqual(balanceCharge(B()), { balance: 30000, damage: 15000, total: 45000 });
    assert.deepStrictEqual(balanceCharge(B({ damageDepositStatus: 'held' })), { balance: 30000, damage: 0, total: 30000 });
});

check('the pay link\'s Checkout: the stay\'s currency, its own kind, back to the pay page on "Back"', () => {
    const p = balanceCheckoutParams({ origin: 'https://h.test', booking: B({ currency: 'EUR' }), what: 'Seaview', when: '5–8 Mar', backPath: '/_book?pay=41&t=x', now: new Date('2027-02-05T10:00:00Z') });
    assert.strictEqual(p.metadata!.bms_kind, 'stay_balance');
    assert.strictEqual(p.metadata!.bms_damage, '1');
    assert.deepStrictEqual(p.line_items!.map((l) => [l.price_data!.currency, l.price_data!.unit_amount]), [['eur', 30000], ['eur', 15000]]);
    assert.strictEqual(p.cancel_url, 'https://h.test/_book?pay=41&t=x');
    assert.ok(String(p.success_url).includes('st=balance'));
});

check('the pay-link emails: the amount, the due date, a button to the site\'s own page', () => {
    const who = { business: 'Harbour Stays', origin: 'https://harbour.bemoreswan.site', assistantId: 5 };
    const first = payLinkEmail(B(), who, 'first');
    assert.ok(first.html.includes('£300') && first.html.includes('Friday 5 February') && first.html.includes('Pay £450'));
    assert.ok(first.html.includes(balancePayUrl(who.origin, 41).replace(/&/g, '&amp;')));
    assert.ok(first.html.includes('refundable damage deposit of £150'));
    assert.match(payLinkEmail(B(), who, 'reminder').subject, /^Reminder:/);
    assert.ok(payLinkEmail(B(), who, 'card_failed').html.includes('couldn\'t take'));
    assert.ok(!payLinkEmail(B(), { ...who, origin: null }, 'first').html.includes('href'), 'no site address: reply instead');
});

check('the jobs: confirmed stays only, claimed before anything is sent or charged, never cancelled automatically', () => {
    const src = read('src/utils/stay-jobs.ts');
    const collect = src.slice(src.indexOf('export async function collectDueBalances'), src.indexOf('export async function chaseUnpaidBalances'));
    assert.ok(collect.includes("eq(bookings.status, 'confirmed'), eq(bookings.balanceStatus, 'due')"));
    assert.ok(collect.indexOf('set({ balanceRequestedAt: now })') < collect.indexOf('chargeBalanceOffSession('), 'claim before charging');
    assert.ok(collect.includes("if (b.balanceCollection === 'auto')"), 'the owner\'s choice, as copied onto the booking');
    assert.ok(collect.includes("balanceStatus: 'failed'") && collect.includes("payLinkEmail(b, who, 'card_failed')") && collect.includes('tellOwner('), 'a failed card falls back to the link and tells the owner');
    assert.ok(!/status: 'cancelled'/.test(src), 'nothing is cancelled automatically');
    const chase = src.slice(src.indexOf('export async function chaseUnpaidBalances'), src.indexOf('export async function remindDamageReturns'));
    assert.ok(chase.includes('3 * DAY') && chase.includes('6 * DAY'));
});

check('the automatic charge uses the card saved at booking, off-session, once (idempotency key)', () => {
    const src = read('src/utils/stay-charges.ts');
    const fn = src.slice(src.indexOf('export async function chargeBalanceOffSession'), src.indexOf('export async function stayBalancePaid'));
    assert.ok(fn.includes('off_session: true, confirm: true') && fn.includes('idempotencyKey: `stay-balance-${b.id}`'));
    assert.ok(fn.includes("if (intent.status !== 'succeeded')"));
});

check('a balance paid from the link: this booking\'s own session, on the account that workspace connected; never a shop order', () => {
    const src = read('src/utils/stay-charges.ts');
    const fn = src.slice(src.indexOf('export async function stayBalancePaid'), src.indexOf('// ── The damage deposit'));
    assert.ok(fn.includes('b.balanceCheckoutSessionId !== session.id') && fn.includes('account.stripeAccountId !== accountId'));
    assert.ok(read('netlify/functions/stripe-connect-webhook.ts').includes("else if (session.metadata?.bms_kind === 'stay_balance') await balanceSettled("));
    assert.ok(read('src/utils/site-shop.ts').includes("if (session.metadata?.bms_kind === 'stay_balance') return false;"));
});

check('the pay page opens Stripe only on a POST, so an email scanner opening the link starts nothing', () => {
    const src = read('src/utils/site-stay-booking.ts');
    const get = src.slice(src.indexOf('export async function stayPayPage'), src.indexOf('export async function stayPaySubmit'));
    assert.ok(!get.includes('startBalanceCheckout(') && get.includes('method="post"'));
    assert.ok(read('src/utils/site-booking.ts').includes("if (body.get('_action') === 'pay_balance')"));
});

console.log('\nthe damage deposit');

check('keeping part: a whole amount, no more than was held, and a reason the guest is sent', () => {
    assert.deepStrictEqual(cleanKeep(15000, 4000, 'A broken lamp'), { ok: true });
    assert.deepStrictEqual(cleanKeep(15000, 0, ''), { ok: true }, 'keeping nothing needs no reason');
    assert.ok(!cleanKeep(15000, 16000, 'Too much').ok);
    assert.ok(!cleanKeep(15000, 4000, '').ok);
    assert.ok(!cleanKeep(15000, -1, 'x').ok);
});

check('the hourly return and the owner\'s click can\'t both refund (claimed first)', () => {
    const src = read('src/utils/stay-charges.ts');
    const fn = src.slice(src.indexOf('export async function settleDamageDeposit'), src.indexOf('// ── What the owner'));
    assert.ok(fn.indexOf("eq(bookings.damageDepositStatus, 'held'), isNull(bookings.damageDecidedAt)") < fn.indexOf('refundStayParts('));
    const jobs = read('src/utils/stay-jobs.ts');
    assert.ok(jobs.includes('settleDamageDeposit(db, b, 0, null)'), 'by itself it always returns ALL of it');
});

check('keeping part is the owner\'s click only, once the stay has begun', () => {
    const src = read('netlify/functions/sites.ts');
    const fn = src.slice(src.indexOf("if (action === 'damage_return' || action === 'damage_keep')"), src.indexOf("if (action === 'booking_decide')"));
    assert.ok(fn.includes('eq(bookings.organisationId, orgId)'));
    assert.ok(fn.includes('b.checkIn > today') && fn.includes('cleanKeep('));
    assert.ok(fn.includes('damageEmail('), 'the guest is told, with the reason');
});

check('the owner sees where the money stands, in words', () => {
    const now = new Date('2027-03-10T09:00:00Z');
    const due = stayMoneyView(B(), now);
    assert.strictEqual(due.balance, 'Balance £300 due 5 Feb (payment link emailed)');
    assert.strictEqual(due.damage, 'Damage deposit £150 — taken with the balance');
    assert.strictEqual(due.damageHeld, false);
    const held = stayMoneyView(B({ balanceStatus: 'paid', damageDepositStatus: 'held' }), now);
    assert.strictEqual(held.balance, 'Balance £300 paid');
    assert.strictEqual(held.damage, 'Damage deposit £150 held — goes back by itself on 15 Mar');
    assert.ok(held.damageHeld && held.canKeep && held.damageAmount === '150');
    assert.strictEqual(stayMoneyView(B({ damageDepositStatus: 'held' }), new Date('2027-03-01T09:00:00Z')).canKeep, false, 'not before the stay begins');
    assert.ok(stayMoneyView(B({ balanceStatus: 'failed' }), now).balanceProblem);
    assert.strictEqual(stayMoneyView(B({ damageDepositStatus: 'part_kept', damageDepositKeptPence: 4000, damageDepositKeptReason: 'Broken lamp' }), now).damage, 'Damage deposit: kept £40, returned £110 — "Broken lamp"');
});

console.log('\narrival details');

const STAY = { name: 'Seaview Cottage', checkInTime: '16:00', checkOutTime: '10:00', address: 'Harbour Lane\nSt Ives', houseRules: 'No parties.', arrivalDetails: 'Key safe by the door: 4321\nWi-Fi: Bluebird <home>', stayType: 'whole' };

check('the arrival email: dates, times, address, the owner\'s arrival details word for word (escaped), house rules', () => {
    const m = arrivalEmail(B(), STAY, 'Harbour Stays');
    assert.strictEqual(m.subject, 'Your arrival details — Seaview Cottage');
    for (const t of ['Friday 5 March', 'for 3 nights', 'from 4pm', 'by 10am on Monday 8 March', 'Harbour Lane<br>St Ives', 'Key safe by the door: 4321<br>Wi-Fi: Bluebird &lt;home&gt;', 'No parties.', 'keep these details to yourself']) {
        assert.ok(m.html.includes(t), `missing ${t}`);
    }
    const noDetails = arrivalEmail(B(), { ...STAY, arrivalDetails: null }, 'Harbour Stays');
    assert.ok(!noDetails.html.includes('Getting in'), 'without arrival details it still gives the times and address');
    const room = arrivalEmail(B({ resourceName: 'Room 3, Room 5', rooms: 2 } as Partial<BookingRow>), { ...STAY, stayType: 'room' }, 'Harbour Stays');
    assert.ok(room.html.includes('Your rooms:</strong> Room 3, Room 5'));
});

check('arrival details go N days before, to confirmed stays, never to a guest who still owes the balance, once', () => {
    const src = read('src/utils/stay-jobs.ts');
    const fn = src.slice(src.indexOf('export async function sendArrivalDetails'), src.indexOf('/** 2a.'));
    assert.ok(fn.includes("eq(bookings.status, 'confirmed'), isNull(bookings.reminderSentAt)"));
    assert.ok(fn.includes('${bookings.checkIn} - ${stayTypes.arrivalDetailsDays} <= ${today}::date') && fn.includes('${bookings.checkIn} >= ${today}::date'));
    assert.ok(fn.includes("NOT IN ('due', 'failed')"), 'held back while the balance is unpaid');
    assert.ok(fn.indexOf('set({ reminderSentAt: now })') < fn.indexOf('sendEmail('), 'claimed before it is sent');
    assert.ok(!fn.includes('new Date(') || !/\$\{[a-z]+Date\}/.test(fn), 'dates bound as strings');
    // It runs last, so a balance charged in the same run releases the details in that run.
    assert.ok(src.indexOf("['arrivalSent', sendArrivalDetails]") > src.indexOf("['balancesAsked', collectDueBalances]"));
});

console.log('\nrefunds across two payments');

check('what was paid for the stay counts both payments', () => {
    assert.strictEqual(stayPaidSoFar(B()), 10000);
    assert.strictEqual(stayPaidSoFar(B({ balanceStatus: 'paid' })), 40000);
    assert.strictEqual(stayPaidSoFar(B({ paymentStatus: 'refunded' })), 0);
});

check('a refund comes off the balance payment first, then the deposit; the damage deposit off the payment that took it', () => {
    const both = B({ balanceStatus: 'paid', balancePaymentIntentId: 'pi_bal', damageDepositStatus: 'held', damagePaymentIntentId: 'pi_bal' });
    assert.deepStrictEqual(refundPlan(both, 20000, 15000), [{ paymentIntent: 'pi_bal', amount: 35000 }]);
    assert.deepStrictEqual(refundPlan(both, 40000, 0), [{ paymentIntent: 'pi_bal', amount: 30000 }, { paymentIntent: 'pi_dep', amount: 10000 }]);
    assert.deepStrictEqual(refundPlan(both, 99999, 0), [{ paymentIntent: 'pi_bal', amount: 30000 }, { paymentIntent: 'pi_dep', amount: 10000 }], 'never more than was paid');
    const fullAtBooking = B({ balanceStatus: 'none', damageDepositStatus: 'held', damagePaymentIntentId: 'pi_dep' });
    assert.deepStrictEqual(refundPlan(fullAtBooking, 5000, 15000), [{ paymentIntent: 'pi_dep', amount: 20000 }]);
    assert.deepStrictEqual(refundPlan(B({ paymentStatus: null }), 5000, 0), [], 'nothing paid, nothing to refund');
});

check('the owner declining or cancelling a stay gives back the balance and damage deposit too', () => {
    assert.ok(read('src/utils/bookings.ts').includes("if (action !== 'confirm' && row.kind === 'stay') await (await import('./stay-charges')).refundStayRest(db, row);"));
});

check('the hourly run does the stay jobs; the day-before reminder leaves stays out', () => {
    const fn = read('netlify/functions/send-booking-reminders.ts');
    assert.ok(fn.includes('await runStayMoneyJobs(getDb(), new Date())'));
    assert.ok(fn.includes("ne(bookings.kind, 'stay')"));
});

check('the SQL has the new columns, mirrored in Drizzle', () => {
    const sqlText = read('db/z-stays.sql');
    const schema = read('db/schema.ts');
    for (const [col, prop] of [['balance_payment_intent_id', 'balancePaymentIntentId'], ['balance_checkout_session_id', 'balanceCheckoutSessionId'], ['balance_requested_at', 'balanceRequestedAt'],
        ['balance_reminded_at', 'balanceRemindedAt'], ['balance_owner_told_at', 'balanceOwnerToldAt'], ['damage_payment_intent_id', 'damagePaymentIntentId'],
        ['damage_reminded_at', 'damageRemindedAt'], ['damage_decided_at', 'damageDecidedAt']]) {
        assert.ok(sqlText.includes(`ADD COLUMN IF NOT EXISTS ${col}`), col);
        assert.ok(schema.includes(`${prop}: `), prop);
    }
});

console.log(`\n${passed}/${total} passed`);
