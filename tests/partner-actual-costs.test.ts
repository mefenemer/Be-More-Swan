// tests/partner-actual-costs.test.ts
// Partner commission after ACTUAL costs (docs/partner-actual-costs-plan.md; owner decisions 2026-11-23).
//
// WHY THIS EXISTS. Be More Swan must never lose money because a partner's customers are heavy users: costs taken off
// are the higher of 20% or that customer's real costs that month (incl. card fees); a month that costs more than the
// customer paid is carried forward against their next months; the partner never owes us anything. Annual plans are
// 12 monthly slices so each month meets its own costs. These tests pin the rule, the slices, the ECB rate maths and the
// wiring (nothing is released before its month is checked; refunds respect measured costs).
//
// Run:  npx tsx tests/partner-actual-costs.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCostRule, parseEcbUsdGbp, serviceSlices, sliceRef, usdToPence } from '../src/utils/partner-costs';
import { commissionForRow, sliceLikePattern } from '../src/utils/partner-ledger';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const angela = (costPence: number, carryInPence = 0, cardFeePence = 0) =>
    applyCostRule({ paymentPence: 6900, minDeductionBps: 2000, costPence, cardFeePence, carryInPence, rateBps: 5000 });

console.log('the rule (the plan’s worked examples, Angela at 50% on the £69 plan)');

check('light month: costs £4 → the 20% minimum (£13.80) comes off → £27.60', () => {
    assert.deepStrictEqual(angela(400), { deductionPence: 1380, basis: 'minimum', availablePence: 5520, commissionPence: 2760, carryOutPence: 0 });
});

check('heavy month: costs £30 → real costs come off → £19.50', () => {
    assert.deepStrictEqual(angela(3000), { deductionPence: 3000, basis: 'actual', availablePence: 3900, commissionPence: 1950, carryOutPence: 0 });
});

check('loss-making month: costs £75 → £0, and £6 is carried forward', () => {
    const r = angela(7500);
    assert.strictEqual(r.commissionPence, 0);
    assert.strictEqual(r.carryOutPence, 600);
});

check('the shortfall carried in is taken off the next month before commission', () => {
    const r = angela(400, 600);   // light month, £6 carried in: 69 − 13.80 − 6 = 49.20 → £24.60
    assert.strictEqual(r.commissionPence, 2460);
    assert.strictEqual(r.carryOutPence, 0);
});

check('a big carry can swallow a whole month and keep carrying', () => {
    const r = angela(400, 9000);  // 69 − 13.80 − 90 = −34.80
    assert.strictEqual(r.commissionPence, 0);
    assert.strictEqual(r.carryOutPence, 3480);
});

check('the card fee counts as a cost (with the other costs, against the 20% minimum)', () => {
    assert.strictEqual(angela(1000, 0, 500).basis, 'actual');           // £10 + £5 fee > £13.80
    assert.strictEqual(angela(1000, 0, 300).basis, 'minimum');          // £13 < £13.80
});

check('never below zero, never more than rate × (payment − minimum); rounding down', () => {
    for (const c of [0, 100, 1380, 1381, 6900, 99999]) {
        const r = angela(c);
        assert.ok(r.commissionPence >= 0 && r.commissionPence <= 2760, String(c));
    }
    assert.strictEqual(applyCostRule({ paymentPence: 2900, minDeductionBps: 2000, costPence: 0, cardFeePence: 0, carryInPence: 0, rateBps: 2500 }).commissionPence, 580);
});

console.log('annual plans: 12 monthly slices');

check('a year paid up front is 12 months, the net shared, the remainder on the last', () => {
    const start = new Date('2026-12-01T00:00:00Z');
    const s = serviceSlices(82800, start, new Date('2027-12-01T00:00:00Z'), start);
    assert.strictEqual(s.length, 12);
    assert.strictEqual(s.reduce((n, x) => n + x.netPence, 0), 82800);
    assert.strictEqual(s[0].periodEnd.toISOString(), '2027-01-01T00:00:00.000Z');
    assert.strictEqual(s[11].periodEnd.toISOString(), '2027-12-01T00:00:00.000Z');
    const odd = serviceSlices(1000, start, new Date('2027-12-01T00:00:00Z'), start);
    assert.strictEqual(odd[11].netPence, 1000 - 83 * 11);
});

check('a monthly payment is one slice; missing dates → one month from the payment', () => {
    const paid = new Date('2026-12-05T10:00:00Z');
    assert.strictEqual(serviceSlices(6900, new Date('2026-12-05T10:00:00Z'), new Date('2027-01-05T10:00:00Z'), paid).length, 1);
    const s = serviceSlices(6900, null, null, paid);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].periodEnd.toISOString(), '2027-01-05T10:00:00.000Z');
});

check('slice references stay unique per payment (the invoice-row unique index)', () => {
    const s = serviceSlices(12000, new Date('2026-12-01Z'), new Date('2027-12-01Z'), new Date('2026-12-01Z'));
    const refs = s.map((x) => sliceRef('in_123', x, s.length));
    assert.strictEqual(new Set(refs).size, 12);
    assert.strictEqual(refs[2], 'in_123#m3');
    assert.strictEqual(sliceRef('in_9', s[0], 1), 'in_9');
});

console.log('dollars → pounds (ECB)');

check('reads the ECB daily XML; pounds per dollar = GBP rate ÷ USD rate', () => {
    const xml = `<Cube><Cube time='2026-11-23'><Cube currency='USD' rate='1.0500'/><Cube currency='JPY' rate='160'/><Cube currency='GBP' rate='0.8400'/></Cube></Cube>`;
    assert.deepStrictEqual(parseEcbUsdGbp(xml), { day: '2026-11-23', usdGbp: 0.8 });
    assert.strictEqual(parseEcbUsdGbp('<Cube time="2026-11-23"></Cube>'), null);
    assert.strictEqual(usdToPence(12.5, 0.8), 1000);
    assert.strictEqual(usdToPence(-1, 0.8), 0);
});

console.log('refunds after the month is checked');

check('a refund keeps the measured costs (the service was used): commission falls further than at the minimum', () => {
    const row = { rateBps: 5000, costDeductionBps: 2000, costsCheckedAt: new Date(), costPence: 3000, cardFeePence: 0, carryInPence: 0 };
    assert.strictEqual(commissionForRow(row, 6900), 1950);
    assert.strictEqual(commissionForRow(row, 3450), 225);      // half refunded: (34.50 − 30) × 50%
    assert.strictEqual(commissionForRow({ ...row, costsCheckedAt: null }, 3450), 1380);   // provisional: at the minimum
});

console.log('wiring');

check('the nightly sweep saves the ECB rate and checks costs BEFORE releasing', () => {
    const sw = read('netlify/functions/partner-commission-sweep.ts');
    const fx = sw.indexOf('await saveTodaysFxRate(db);'), up = sw.indexOf('await trueUpCommissions(db, now);'), rel = sw.indexOf('await releaseDueCommissions(db, now);');
    assert.ok(fx > 0 && fx < up && up < rel);
    const led = read('src/utils/partner-ledger.ts');
    assert.ok(led.includes("sql`${partnerCommissions.costsCheckedAt} IS NOT NULL`, sql`${partnerCommissions.servicePeriodEnd} IS NULL`"), 'unchecked months are never released');
});

check('the true-up only touches PENDING, unchecked rows, in month order per customer, and carries the shortfall on', () => {
    const db = read('src/utils/partner-costs-db.ts');
    assert.ok(db.includes("eq(partnerCommissions.status, 'pending'),") && db.includes('isNull(partnerCommissions.costsCheckedAt), lte(partnerCommissions.servicePeriodEnd, now)'));
    assert.ok(db.includes('.orderBy(asc(partnerCommissions.partnerReferralId), asc(partnerCommissions.servicePeriodStart)'));
    assert.ok(db.includes('.set({ costCarryPence: r.carryOutPence })'));
    assert.ok(db.includes('Math.min(row.commissionPence, r.commissionPence)'), 'a refund applied while waiting is kept');
    assert.ok(db.includes("role = 'owner'"), 'costs of the workspaces the customer owns');
});

check('the card fee comes from Stripe’s balance transaction, only for partner customers', () => {
    const w = read('netlify/functions/stripe-webhook.ts');
    assert.ok(w.includes("feePence: Math.max(0, bt.fee ?? 0)"));
    assert.ok(w.includes('cardFeePence: payment.cardFeePence ?? st?.feePence ?? null'));
});

check('Terms 3.2 and the frozen v1.3 copy say the same rule; Partner page shows the breakdown', () => {
    for (const f of ['partner-terms.html', 'partner-terms-v1.3.html']) {
        const t = read(f);
        assert.ok(t.includes('<strong>the higher of</strong> (a) a minimum share of that month’s Subscription Payment, currently <strong>20%</strong>'), f);
        assert.ok(t.includes('the difference is carried forward'), f);
        assert.ok(t.includes('card and payment processing fees'), f);
        assert.ok(t.includes('An annual Subscription Payment is treated as twelve equal monthly payments'), f);
        assert.ok(t.includes('We set, and may change at any time, our prices, plans, features and usage limits'), f);
    }
    const page = read('partner-content.html');
    assert.ok(page.includes("const costsCell = (c) =>") && page.includes("worked out at month end") && page.includes("carried forward</span>"));
});

check('SQL and schema agree', () => {
    const sql = read('db/z-partner-actual-costs.sql');
    for (const c of ['service_period_start', 'cost_pence', 'card_fee_pence', 'deduction_basis', 'carry_out_pence', 'costs_checked_at', 'cost_carry_pence', 'CREATE TABLE IF NOT EXISTS fx_rates']) assert.ok(sql.includes(c), c);
    const schema = read('db/schema.ts');
    for (const c of ['costsCheckedAt: timestamp("costs_checked_at")', 'costCarryPence: integer("cost_carry_pence")', 'export const fxRates = pgTable("fx_rates"']) assert.ok(schema.includes(c), c);
});

console.log('review of #827');

check('H1: a refund or dispute with only the invoice id still finds all 12 annual slices', () => {
    assert.strictEqual(sliceLikePattern('in_1AbC'), 'in\\_1AbC#m%', '"_" escaped: it is a LIKE wildcard');
    const led = read('src/utils/partner-ledger.ts');
    const matchers = (led.match(/inArray\(partnerCommissions\.stripeInvoiceId, keys\), \.\.\.sliceRefMatchers\(keys\)/g) || []).length;
    assert.strictEqual(matchers, 2, 'both reversePartnerCommission and reinstateDisputedCommission');
    // Every slice ref the ledger writes matches the pattern for its payment.
    const slices = serviceSlices(12000, new Date('2026-12-01Z'), new Date('2027-12-01Z'), new Date('2026-12-01Z'));
    const like = new RegExp('^' + sliceLikePattern('in_1AbC').replace(/\\_/g, '_').replace('#m%', '#m.*') + '$');
    for (const sl of slices) assert.ok(like.test(sliceRef('in_1AbC', sl, slices.length)));
    assert.ok(read('netlify/functions/stripe-webhook.ts').includes('paymentIntentId: payment.paymentIntentId ?? st?.paymentIntentId ?? null'), 'the PaymentIntent found is stored');
});

check('M2: overlapping months (a mid-month plan change) never count the same days twice', () => {
    const db = read('src/utils/partner-costs-db.ts');
    assert.ok(db.includes('const countFrom = await costsCountedUntil(db, refId!, row.id, row.servicePeriodStart!);'));
    assert.ok(db.includes('await customerCostUsd(db, Number(userId), countFrom, countTo) : 0;'));
    assert.ok(db.includes("AND kind = 'invoice' AND id <> ${rowId} AND costs_checked_at IS NOT NULL"));
});

check('L3: the true-up never raises a row (a refund or a dispute-won-after-refund stays applied)', () => {
    assert.ok(read('src/utils/partner-costs-db.ts').includes('const commission = Math.min(row.commissionPence, r.commissionPence);'));
    // …and that is always safe: the rule never gives more than the provisional figure at the minimum.
    for (const c of [0, 500, 1380, 3000, 9000]) for (const carry of [0, 600]) {
        const r = applyCostRule({ paymentPence: 6900, minDeductionBps: 2000, costPence: c, cardFeePence: 0, carryInPence: carry, rateBps: 5000 });
        assert.ok(r.commissionPence <= 2760);
    }
});

check('L4 / L5: only inserted months are announced; the ECB fetch times out', () => {
    const led = read('src/utils/partner-ledger.ts');
    assert.ok(led.includes('values.filter((v) => insertedRefs.has(v.stripeInvoiceId))'));
    assert.ok(read('src/utils/partner-costs.ts').includes('signal: AbortSignal.timeout(8_000)'));
});

console.log('second review of #827');

check('H1: a month whose customer deleted their account is still checked (minimum, no costs, no carry) — never stuck', () => {
    const db = read('src/utils/partner-costs-db.ts');
    assert.ok(db.includes('.leftJoin(partnerReferrals, eq(partnerReferrals.id, partnerCommissions.partnerReferralId))'));
    assert.ok(db.includes('const orphan = !refId || !refExists || !userId;'));
    assert.ok(db.includes('carryOutPence: orphan ? 0 : r.carryOutPence'));
});

check('M2: a won dispute on a month not yet costed goes back to pending, never straight to payable', () => {
    const led = read('src/utils/partner-ledger.ts');
    assert.ok(led.includes("const uncosted = !!row.servicePeriodEnd && !row.costsCheckedAt;"));
    assert.ok(led.includes("(!uncosted && row.availableAt && row.availableAt <= at ? 'payable' : 'pending')"));
});

check('L3: after a partial refund, costs come off what is left of the payment (£100, half refunded, £40 costs → £5)', () => {
    // provisional at the 20% minimum = £40; half refunded → row £20 → remaining payment £50; costs £40 → (50 − 40) × 50% = £5
    const payment = Math.floor((10000 * 2000) / 4000);
    assert.strictEqual(payment, 5000);
    assert.strictEqual(applyCostRule({ paymentPence: payment, minDeductionBps: 2000, costPence: 4000, cardFeePence: 0, carryInPence: 0, rateBps: 5000 }).commissionPence, 500);
    assert.ok(read('src/utils/partner-costs-db.ts').includes('row.commissionPence < provisional ? Math.floor((net * row.commissionPence) / provisional) : net'));
});

check('L4: the last month counts only its costs inside the commission period (it earns pro rata)', () => {
    const db = read('src/utils/partner-costs-db.ts');
    assert.ok(db.includes('const windowEnd = subscribedAt && durationMonths != null ? addMonthsUtc(new Date(subscribedAt), durationMonths) : null;'));
    assert.ok(db.includes('await customerCostUsd(db, Number(userId), countFrom, countTo)'));
});

console.log(`\n${passed} passed`);
