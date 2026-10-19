// tests/partner-payout-runs.test.ts
// Affiliate Partner Programme, step 6 — the admin ledger and monthly payout runs
// (docs/affiliate-partner-programme-plan.md §4.4–4.5).
//
// WHY THIS EXISTS (2026-10-18). A payment file is uploaded to Wise / PayPal and moves real money: a
// wrong column, a stray formula, a person paid by the wrong method or twice, is money gone. Pins
// the file formats (PayPal's is documented exactly; Wise's headers live in ONE constant to check
// against the downloaded template), CSV-injection safety, and GUI/chat parity for every new action.
// The SQL (who is due, locking rows into a run, paid / cancelled) is proven in
// tests/partner-payout-runs-db.test.ts.
//
// Run:  npx tsx tests/partner-payout-runs.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExport, paymentReference, WISE_BANK_HEADERS, type BatchLine } from '../src/utils/partner-payout-batches';
import { proposeBatchStatus, proposeBonus, proposeCreateBatch, proposeVoidCommission } from '../src/utils/partner-ops-proposals';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const LINES: BatchLine[] = [
    { partnerId: 1, name: 'Ann Bank', email: 'ann@example.com', amountPence: 12550, details: { method: 'bank', accountName: 'Ann Bank', sortCode: '112233', accountNumber: '01234567' } },
    { partnerId: 2, name: 'Wil Wise', email: 'wil@example.com', amountPence: 5000, details: { method: 'wise', email: 'wil.wise@example.com' } },
    { partnerId: 3, name: 'Pam Pal', email: 'pam@example.com', amountPence: 7525, details: { method: 'paypal', email: 'pam.pay@example.com' } },
    { partnerId: 4, name: '=HYPERLINK("evil")', email: 'x@example.com', amountPence: 6000, details: { method: 'bank', accountName: '=cmd|calc', sortCode: '445566', accountNumber: '76543210' } },
    { partnerId: 5, name: 'No Details', email: 'nd@example.com', amountPence: 9000, details: null },
];

console.log('payment files');

check('Wise bank file: header, then one row per bank partner, pounds with 2dp, GBP→GBP', () => {
    const f = buildExport('wise_bank', 12, LINES);
    const rows = f.csv.trim().split('\r\n');
    assert.strictEqual(rows[0], WISE_BANK_HEADERS.join(','));
    assert.strictEqual(rows[1], 'Ann Bank,ann@example.com,BMS PARTNER 12,PRIVATE,GBP,125.50,GBP,GBP,112233,01234567');
    assert.deepStrictEqual([f.included, f.skipped, f.totalPence], [2, 3, 18550]);
});

check('a cell starting with = + - @ is neutralised (CSV formula injection), and quoted when needed', () => {
    const row = buildExport('wise_bank', 12, LINES).csv.trim().split('\r\n')[2];
    assert.ok(row.startsWith("'=cmd|calc,"), row);
});

check('Wise email file pays Wise users by email; PayPal file has NO header and PayPal\'s documented columns', () => {
    const w = buildExport('wise_email', 12, LINES).csv.trim().split('\r\n');
    assert.strictEqual(w[1], 'Wil Wise,wil.wise@example.com,BMS PARTNER 12,PRIVATE,GBP,50.00,GBP,GBP');
    const pp = buildExport('paypal', 12, LINES).csv.trim().split('\r\n');
    assert.deepStrictEqual(pp, ['pam.pay@example.com,75.25,GBP,P3-B12,Be More Swan partner commission,PAYPAL']);
});

check('nobody is in two files, and nobody without details is in any', () => {
    const all = ['wise_bank', 'wise_email', 'paypal'].map((f) => buildExport(f as any, 12, LINES));
    assert.strictEqual(all.reduce((s, f) => s + f.included, 0), 4);
    assert.ok(all.every((f) => !f.csv.includes('nd@example.com')));
});

check('UK bank references fit Faster Payments (18 characters)', () => {
    assert.ok(paymentReference(123456).length <= 18);
});

console.log('chat cards');
const ledger = [
    { id: 10, partnerId: 1, status: 'payable', amountPence: 725, inBatch: false, who: 'Ann' },
    { id: 11, partnerId: 1, status: 'payable', amountPence: 725, inBatch: true, who: 'Ann' },
    { id: 12, partnerId: 1, status: 'paid', amountPence: 725, inBatch: true, who: 'Ann' },
];

check('cancel: only waiting / ready money outside a run, with a reason', () => {
    const r = proposeVoidCommission(ledger, { commissionId: 10, reason: 'Duplicate signup' }) as any;
    assert.deepStrictEqual(r.card.request, { action: 'void', commissionId: 10, reason: 'Duplicate signup' });
    assert.match((proposeVoidCommission(ledger, { commissionId: 11, reason: 'x' }) as any).error, /payout run/);
    assert.match((proposeVoidCommission(ledger, { commissionId: 12, reason: 'x' }) as any).error, /paid/);
    assert.match((proposeVoidCommission(ledger, { commissionId: 10, reason: ' ' }) as any).error, /reason/);
});

check('bonus in pence, approved partners only; a run only when someone is due; mark paid / cancel only open runs', () => {
    const partners = [{ id: 1, status: 'approved', name: 'Ann', email: null }, { id: 2, status: 'applied', name: 'Jo', email: null }];
    assert.deepStrictEqual((proposeBonus(partners, { partnerId: 1, amountPounds: 25.5, note: 'Thanks' }) as any).card.request, { action: 'bonus', partnerId: 1, amountPence: 2550, note: 'Thanks' });
    assert.match((proposeBonus(partners, { partnerId: 2, amountPounds: 5, note: 'x' }) as any).error, /approved/);
    assert.match((proposeCreateBatch({ lines: [{ due: false, amountPence: 100 }], totalDuePence: 0 }) as any).error, /Nobody/);
    const runs = [{ id: 3, status: 'exported', totalPence: 100, partnerCount: 1 }, { id: 4, status: 'paid', totalPence: 100, partnerCount: 1 }];
    assert.deepStrictEqual((proposeBatchStatus(runs, { batchId: 3 }, 'mark_paid') as any).card.request, { action: 'mark_paid', batchId: 3 });
    assert.match((proposeBatchStatus(runs, { batchId: 4 }, 'cancel_batch') as any).error, /paid/);
});

console.log('GUI and chat — one server action each');
const api = read('netlify/functions/admin-partners.ts');
const chat = read('netlify/functions/admin-partners-chat.ts');
const html = read('admin.html');

check('every new action is handled by admin-partners.ts and audited', () => {
    for (const a of ['void', 'bonus', 'create_batch']) assert.ok(api.includes(`if (body.action === '${a}') {`), a);
    assert.ok(api.includes("if (body.action === 'mark_paid' || body.action === 'cancel_batch') {"));
    assert.ok((api.match(/await audit\('partner_(ledger_change|payout)'/g) || []).length >= 5);
});

check('every new action has a screen control and a chat card', () => {
    for (const fn of ['ledgerVoid(', 'ledgerSaveBonus(', 'payoutCreate(', 'payoutMarkPaid(', 'payoutCancel(']) assert.ok(html.includes(`async function ${fn}`), fn);
    for (const t of ['propose_void_commission', 'propose_bonus', 'propose_create_batch', 'propose_mark_batch_paid', 'propose_cancel_batch', 'ledger', 'payouts']) {
        assert.ok(chat.includes(`tool('${t}',`), t);
    }
});

check('payment files: downloaded only from the screen, decrypted only there, and every download audited', () => {
    assert.ok(!/export|batchLines|getPayoutDetails/.test(chat.replace(/export (default|const)/g, '')), 'the chat must never produce payment files');
    const exp = api.slice(api.indexOf("if (event.httpMethod === 'GET' && qp.export) {"));
    assert.ok(exp.indexOf('await batchLines(db, batchId)') < exp.indexOf("await audit('partner_payout', batchId, undefined, { exported: format"));
});

check('the bonus modal sits outside every .admin-view', () => {
    const at = html.indexOf('<div id="ledger-bonus-modal"');
    const before = html.slice(0, at);
    assert.ok(at > 0 && (before.match(/<\/section>/g) || []).length >= (before.match(/<section id="view-/g) || []).length);
});

console.log(`\n${passed} passed`);
