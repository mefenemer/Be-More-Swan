// tests/partner-us-bank-and-page-info.test.ts
// Owner requests 2026-11-23: (1) "Some people may have a US bank account" — a US bank payout option, paid via
// Wise in USD; (2) an ⓘ on each Partner page number saying how it's counted; (3) the partner's renewal date.
//
// WHY THIS EXISTS. Payout details are money: a typo'd routing number sends a payout nowhere, so it's checked
// (ABA check digit); details stay in the vault and are only ever shown masked; and the Wise file must put
// each field in the right column. The ⓘ texts must match how the numbers are really counted.
//
// Run:  npx tsx tests/partner-us-bank-and-page-info.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidRoutingNumber, maskPayoutDetails, validatePayoutDetails, US_STATES, PAYOUT_METHODS } from '../src/utils/partner-payouts';
import { WISE_US_HEADERS, buildExport } from '../src/utils/partner-payout-batches';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
// 021000021 is a widely published example routing number (it passes the check digit); account numbers are made up.
const good = { method: 'us_bank', accountName: 'Example Collab LLC', holderType: 'business', routingNumber: '021000021', accountNumber: '000123456789',
    accountType: 'checking', addressLine: '1 Example Street', city: 'New York', state: 'ny', zip: '10001' };

console.log('US bank details');

check('the routing number check digit catches typos', () => {
    assert.ok(isValidRoutingNumber('021000021'));
    assert.ok(isValidRoutingNumber('011000015'));
    assert.ok(!isValidRoutingNumber('021000022'), 'one digit off');
    assert.ok(!isValidRoutingNumber('000000000'), 'all zeros');
    assert.ok(!isValidRoutingNumber('02100002'), '8 digits');
});

check('a complete US account is accepted and tidied (state upper-cased, routing spaces dropped)', () => {
    const r = validatePayoutDetails({ ...good, routingNumber: '0210 00021' });
    assert.ok(r.ok);
    if (r.ok && r.value.method === 'us_bank') { assert.strictEqual(r.value.state, 'NY'); assert.strictEqual(r.value.routingNumber, '021000021'); }
    assert.ok(PAYOUT_METHODS.includes('us_bank' as any) && US_STATES.includes('DC' as any));
});

check('each missing or wrong field gets a plain error', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
        [{ accountName: '' }, /name on the bank account/],
        [{ holderType: 'x' }, /personally or to a business/],
        [{ routingNumber: '123456789' }, /routing number/],
        [{ accountNumber: '12' }, /4 to 17 digits/],
        [{ accountType: 'current' }, /checking or savings/],
        [{ addressLine: '' }, /street address/],
        [{ state: 'ZZ' }, /state/],
        [{ zip: '1234' }, /ZIP/],
    ];
    for (const [patch, re] of bad) {
        const r = validatePayoutDetails({ ...good, ...patch });
        assert.ok(!r.ok && re.test(r.error), JSON.stringify(patch));
    }
});

check('only ever shown masked', () => {
    const r = validatePayoutDetails(good);
    assert.ok(r.ok);
    if (r.ok) {
        const m = maskPayoutDetails(r.value);
        assert.strictEqual(m, 'US bank · Example Collab LLC · checking ****6789');
        assert.ok(!m.includes('021000021') && !m.includes('Example Street'));
    }
});

check('Wise · US bank file: right columns, GBP amount → USD, BUSINESS for an LLC; other methods left out', () => {
    const r = validatePayoutDetails(good); assert.ok(r.ok);
    const lines = [
        { partnerId: 1, name: 'A', email: 'a@example.com', amountPence: 12345, details: r.ok ? r.value : null },
        { partnerId: 2, name: 'B', email: 'b@example.com', amountPence: 5000, details: { method: 'paypal' as const, email: 'b@example.com' } },
    ];
    const f = buildExport('wise_us', 7, lines);
    const [head, row] = f.csv.trim().split('\r\n');
    assert.strictEqual(head, WISE_US_HEADERS.join(','));
    const cells = row.split(',');
    const at = (h: string) => cells[WISE_US_HEADERS.indexOf(h)];
    assert.strictEqual(at('receiverType'), 'BUSINESS');
    assert.strictEqual(at('amount'), '123.45');
    assert.strictEqual(at('amountCurrency'), 'GBP');
    assert.strictEqual(at('targetCurrency'), 'USD');
    assert.strictEqual(at('abartn'), '021000021');
    assert.strictEqual(at('accountType'), 'CHECKING');
    assert.strictEqual(at('addressState'), 'NY');
    assert.strictEqual(at('addressCountryCode'), 'US');
    assert.strictEqual(f.included, 1); assert.strictEqual(f.skipped, 1);
});

check('wired: SQL allows us_bank; admin can download the file; privacy says what we hold', () => {
    assert.ok(read('db/z-partner-us-bank.sql').includes("CHECK (payout_method IN ('wise', 'paypal', 'bank', 'us_bank'))"));
    assert.ok(read('db/schema.ts').includes("IN ('wise','paypal','bank','us_bank')"));
    assert.ok(read('netlify/functions/admin-partners.ts').includes("['wise_bank', 'wise_email', 'wise_us', 'paypal'].includes(format)"));
    assert.ok(read('admin.html').includes("['wise_us', 'Wise · US bank', b.us_bank_partners || 0]"));
    assert.ok(read('privacy.html').includes('US bank account name, routing number, account number and type'));
    const page = read('partner-content.html');
    assert.ok(page.includes('value="us_bank"') && page.includes("routingNumber: v('pt-us-routing')"));
    assert.ok(page.includes('<select id="pt-us-holder" class="mt-1 block w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"><option value="">Choose…</option>'), 'no silent default to business');
});

console.log('Partner page: ⓘ and renewal date');

check('every number card has an ⓘ wired to its explanation', () => {
    const page = read('partner-content.html');
    for (const k of ['visits', 'signups', 'trial', 'paying', 'paid', 'payable', 'pending']) {
        assert.ok(page.includes(`aria-controls="pt-info-${k}"`), k);
        assert.ok(page.includes(`id="pt-info-${k}"`), k);
    }
    assert.ok(page.includes('function toggleInfo(btn)'));
});

check('the ⓘ texts match how the numbers are counted', () => {
    const page = read('partner-content.html');
    assert.ok(page.includes('capped at 30 an hour'), 'visits: CLICK_LIMIT 30/hour');
    assert.ok(read('netlify/functions/invite-lookup.ts').includes('maxAttempts: 30, windowSecs: 3600'));
    assert.ok(page.includes('since you became a partner'), 'sign-ups since approval');
    assert.ok(page.includes('free first month doesn’t count'), 'paying = a payment that took money');
    assert.ok(page.includes('${rules.holdingDays ?? 30}-day holding period'), 'live holding days, not a hard-coded 30');
});

check('renewal date = when the current rate ends; none set → 30 days’ notice (Terms 8.1)', () => {
    const hub = read('netlify/functions/partner-hub.ts');
    assert.ok(hub.includes('renewsOn: current.endsAt ?? null'));
    assert.ok(hub.includes('partnerSince: p.decidedAt ?? null'));
    const page = read('partner-content.html');
    assert.ok(page.includes('Renewal date <strong>'));
    assert.ok(page.includes('Renewal date: <strong>none set</strong>'));
    assert.ok(page.includes('(Partner Terms 3.3 and 8.1)'), '3.3 = rates change for future customers, via section 8');
    assert.ok(read('partner-terms.html').includes('8.1'), 'the clause it points to exists');
});

console.log(`\n${passed} passed`);
