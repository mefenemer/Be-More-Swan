// tests/partner-ended-and-disputes.test.ts
// Affiliate Partner Programme — gaps the legal review of Partner Terms v1.1 found in the code
// (2026-10-23). The ledger behaviour itself is tested on real Postgres in partner-ledger-db.test.ts.
//
// WHY THIS EXISTS. Two promises the Terms make that the code didn't keep:
//   - 7.1 / 7.2: a partner can leave, or we can end it. Only 'suspended' existed ("paused, may come
//     back"), so an ended partnership couldn't be recorded. Now 'ended': no new earning, what they
//     earned before is still paid (7.3), GUI and Partner Ops chat alike.
//   - A dispute voids commission when it opens; a WON dispute only came back as a manual bonus.
//     charge.dispute.closed (won) now reinstates it.
//
// Run:  npx tsx tests/partner-ended-and-disputes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeDecision } from '../src/utils/partner-ops-proposals';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log("the 'ended' status");

check('the database allows it (migration replaces the status CHECK in one transaction)', () => {
    const sql = read('db/z-affiliate-partner-ended.sql');
    assert.ok(sql.includes("CHECK (status IN ('applied', 'approved', 'rejected', 'suspended', 'ended'))"));
    assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('DROP CONSTRAINT IF EXISTS partners_status_check') && sql.includes('COMMIT;'));
});

check('admin: end from approved or suspended; an ended partner can be approved again', () => {
    const api = read('netlify/functions/admin-partners.ts');
    assert.ok(api.includes("end:       { from: ['approved', 'suspended'], to: 'ended',   label: 'ended' },"));
    assert.ok(api.includes("approve:   { from: ['applied', 'rejected', 'ended'], to: 'approved', label: 'approved' },"));
    const page = read('admin.html');
    assert.ok(page.includes("btn('End', 'btn-destructive', 'end')") && page.includes("ended: btn('Approve again', 'btn-golive', 'approve'),"));
});

check('Partner Ops chat can propose it too (GUI and chat parity)', () => {
    const partners = [{ id: 1, status: 'approved', name: 'Ann', email: null }, { id: 2, status: 'applied', name: 'Bo', email: null }] as any;
    const ok = proposeDecision(partners, { partnerId: 1, decision: 'end' });
    assert.ok('card' in ok && ok.card.request.action === 'decide' && (ok.card.request as any).decision === 'end');
    assert.ok('error' in proposeDecision(partners, { partnerId: 2, decision: 'end' }), 'an applicant cannot be ended');
    assert.ok(read('netlify/functions/admin-partners-chat.ts').includes("enum: ['approve', 'reject', 'suspend', 'reinstate', 'end']"));
});

check('ended partners are still paid what they earned (7.3), and earn nothing new', () => {
    const runs = read('src/utils/partner-payout-batches.ts');
    assert.ok(runs.includes("const reason = !['approved', 'suspended', 'ended'].includes(r.status) ? `Partner is ${r.status}`"));
    // New commission needs an APPROVED partner — ended is left out by the same check as suspended.
    assert.ok(read('src/utils/partner-ledger.ts').includes("eq(partners.status, 'approved')"));
});

check('their Partner page keeps earnings and payout details, without the link or the assistant', () => {
    const hub = read('netlify/functions/partner-hub.ts');
    assert.ok(hub.includes("const code = live && p.status !== 'ended'\n            ? impersonating ? await readReferralCode(db, userId) : await ensureReferralCode(db, userId)\n            : null;"));
    const page = read('partner-content.html');
    assert.ok(page.includes('id="pt-ended"') && page.includes("show('pt-invite-card', data.partner.status !== 'ended');"));
    assert.ok(page.includes("show('pt-assistant-card', data.partner.status !== 'ended');"));
});

console.log('won disputes');

check("charge.dispute.closed with status 'won' reinstates; refunds on the charge stay unearned", () => {
    const wh = read('netlify/functions/stripe-webhook.ts');
    const block = wh.slice(wh.indexOf("if (stripeEvent.type === 'charge.dispute.closed') {"));
    assert.ok(block.length > 100, 'handler exists');
    assert.ok(block.includes("if (dispute.status === 'won') {"));
    assert.ok(block.includes("refunded = (await stripe.charges.retrieve(chargeId)).amount_refunded ?? 0;"));
    assert.ok(wh.includes('await reinstateDisputedCommission(db, { paymentIntentId, invoiceId, amountRefundedPence, at });'));
});

console.log(`\n${passed} passed`);
