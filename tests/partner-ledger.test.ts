// tests/partner-ledger.test.ts
// Affiliate Partner Programme, step 2 — the commission ledger's wiring (docs/affiliate-partner-programme-plan.md §4.3).
// The money SQL itself is proven on real Postgres in tests/partner-ledger-db.test.ts (CI rls job).
//
// WHY THIS EXISTS (2026-10-18):
//   1. A new subscription's FIRST payment never reaches invoice.paid (subscription_create is
//      skipped there), so a ledger hooked only into invoice.paid would cost every partner month one.
//   2. There was no charge.refunded handler at all — a refunded customer would still earn their
//      partner commission.
//   3. A partner's referral must earn cash OR a token, never both.
//
// Run:  npx tsx tests/partner-ledger.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoiceNetPence, sessionNetPence } from '../src/utils/partner-ledger';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** The body of one `if (stripeEvent.type === '<type>') {` block, up to the next one. */
function eventBlock(src: string, type: string): string {
    const start = src.indexOf(`if (stripeEvent.type === '${type}')`);
    assert.ok(start >= 0, `no ${type} handler`);
    const next = src.indexOf('if (stripeEvent.type ===', start + 10);
    return src.slice(start, next === -1 ? undefined : next);
}

console.log('net amounts (commission is never paid on VAT)');

check('invoice: what was paid, minus tax', () => {
    assert.strictEqual(invoiceNetPence({ amount_paid: 3480, total: 3480, total_excluding_tax: 2900 }), 2900);
    assert.strictEqual(invoiceNetPence({ amount_paid: 2900, total: 2900, total_excluding_tax: 2900 }), 2900);
});

check('invoice: customer-balance credit is not money received', () => {
    assert.strictEqual(invoiceNetPence({ amount_paid: 1900, total: 2900, total_excluding_tax: 2900 }), 1900);
    assert.strictEqual(invoiceNetPence({ amount_paid: 0, total: 2900, total_excluding_tax: 2900 }), 0);
});

check('checkout session: total minus tax', () => {
    assert.strictEqual(sessionNetPence({ amount_total: 3480, total_details: { amount_tax: 580 } }), 2900);
    assert.strictEqual(sessionNetPence({ amount_total: 0, total_details: null }), 0);
});

console.log('webhook wiring');
const webhook = read('netlify/functions/stripe-webhook.ts');

check('every payment path records the partner commission (first payment included)', () => {
    for (const type of ['checkout.session.completed', 'payment_intent.succeeded', 'invoice.paid']) {
        assert.ok(eventBlock(webhook, type).includes('await _recordPartnerCommission(db, {'), `${type} does not record a commission`);
    }
});

check('the commission is recorded only where money was taken (same gate as the referral token)', () => {
    const session = eventBlock(webhook, 'checkout.session.completed');
    const gate = session.indexOf('if ((session.amount_total ?? 0) > 0) {');
    assert.ok(gate >= 0 && session.indexOf('_recordPartnerCommission', gate) > gate);
    const inv = eventBlock(webhook, 'invoice.paid');
    const invGate = inv.indexOf('if (invoice.amount_paid > 0) {');
    assert.ok(invGate >= 0 && inv.indexOf('_recordPartnerCommission', invGate) > invGate);
});

check('the payment time comes from the Stripe event, so a redelivery lands on the same date', () => {
    const calls = webhook.match(/paidAt:\s+new Date\(stripeEvent\.created \* 1000\)/g) ?? [];
    assert.strictEqual(calls.length, 3);
});

check('refunds and disputes reverse the commission', () => {
    assert.ok(eventBlock(webhook, 'charge.refunded').includes("_reversePartnerCommission(db, charge.payment_intent, charge.amount_refunded ?? 0, 'refund'"));
    assert.ok(eventBlock(webhook, 'charge.dispute.created').includes("_reversePartnerCommission(db, dispute.payment_intent, dispute.amount ?? 0, 'dispute'"));
});

check('a ledger failure never fails the webhook, but is logged loudly', () => {
    assert.ok(webhook.includes("console.error('[stripe-webhook] partner commission NOT recorded — record it by hand:'"));
    assert.ok(webhook.includes('partner commission NOT adjusted after a ${kind} — fix it by hand:'));
});

console.log('cash or token, never both');
const offer = read('src/utils/referral-offer.ts');

check("a partner's referral is marked 'partner' before the token branch", () => {
    const partner = offer.indexOf('if (await isPartnerReferrer(db, pendingReferral.referrerId)) {');
    const token = offer.indexOf(".set({ status: 'qualified', qualifiedAt: new Date() })");
    assert.ok(partner > 0 && token > partner);
    assert.ok(offer.slice(partner, token).includes("status: 'partner'") && offer.slice(partner, token).includes('return false;'));
});

check('the token vault still counts qualified referrals only', () => {
    assert.ok(read('src/utils/referral-tokens.ts').includes("eq(userReferrals.status, 'qualified')"));
});

console.log('nightly release');

check('scheduled on production, poked on staging, DB test in CI', () => {
    assert.match(read('netlify.toml'), /\[functions\.partner-commission-sweep\]\n\s+schedule = "35 2 \* \* \*"/);
    assert.match(read('.github/workflows/staging-crons.yml'), /^\s+run-partner-sweep\s+86400\s+\d+$/m);
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/partner-ledger-db.test.ts'));
});

check('the release query uses query-builder operators, never a Date bound into raw sql', () => {
    const ledger = read('src/utils/partner-ledger.ts');
    const fn = ledger.slice(ledger.indexOf('export async function releaseDueCommissions'));
    assert.ok(fn.includes('lte(partnerCommissions.availableAt, now)'));
    assert.ok(!/sql`[^`]*\$\{now\}/.test(fn));
});

console.log(`\n${passed} passed`);
