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
import { isValidBic, isValidIban, isValidRoutingNumber, maskPayoutDetails, validatePayoutDetails, US_STATES, PAYOUT_METHODS } from '../src/utils/partner-payouts';
import { WISE_BANK_HEADERS, WISE_EUR_HEADERS, WISE_US_HEADERS, buildExport } from '../src/utils/partner-payout-batches';

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
    const short = validatePayoutDetails({ ...good, accountNumber: '4821' });
    assert.ok(short.ok && maskPayoutDetails(short.value).endsWith('****21'), 'a 4-digit number is never shown whole');
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
    // Exactly Wise's own header (its template, GBP → USD US bank account, downloaded 2026-11-23).
    assert.strictEqual(head, 'name,recipientEmail,paymentReference,referenceNumber,receiverType,amountCurrency,amount,sourceCurrency,targetCurrency,sortCode,accountNumber,type,abartn,accountType,addressCountryCode,addressFirstLine,addressCity,addressState,addressPostCode');
    const cells = row.split(',');
    const at = (h: string) => cells[WISE_US_HEADERS.indexOf(h)];
    assert.strictEqual(at('receiverType'), 'INSTITUTION', 'Wise’s word for a business recipient (its template, 2026-11-23)');
    assert.strictEqual(at('amount'), '123.45');
    assert.strictEqual(at('amountCurrency'), 'source', 'the amount is in the source currency — Wise’s template value');
    assert.strictEqual(at('referenceNumber'), '');
    assert.strictEqual(at('targetCurrency'), 'USD');
    assert.strictEqual(at('abartn'), '021000021');
    assert.strictEqual(at('type'), 'Aba');
    assert.strictEqual(at('sortCode'), '');
    assert.strictEqual(at('accountNumber'), '000123456789');
    assert.strictEqual(at('accountType'), 'CHECKING');
    assert.strictEqual(at('addressState'), 'NY');
    assert.strictEqual(at('addressCountryCode'), 'US');
    assert.strictEqual(f.included, 1); assert.strictEqual(f.skipped, 1);
    const personal = validatePayoutDetails({ ...good, holderType: 'person' });
    assert.ok(personal.ok);
    const p = buildExport('wise_us', 7, [{ partnerId: 3, name: 'C', email: 'c@example.com', amountPence: 100, details: personal.ok ? personal.value : null }]).csv.trim().split('\r\n')[1].split(',');
    assert.strictEqual(p[WISE_US_HEADERS.indexOf('receiverType')], 'PERSON', 'Wise’s word for a personal account (its template, 2026-11-23) — not PRIVATE');
});

check('wired: SQL allows us_bank; admin can download the file; privacy says what we hold', () => {
    assert.ok(read('db/z-partner-us-bank.sql').includes("CHECK (payout_method IN ('wise', 'paypal', 'bank', 'us_bank'))"));
    assert.ok(read('db/schema.ts').includes("IN ('wise','paypal','bank','us_bank'"));
    assert.ok(read('netlify/functions/admin-partners.ts').includes("['wise_bank', 'wise_email', 'wise_us', 'wise_eur', 'paypal'].includes(format)"));
    assert.ok(read('admin.html').includes("['wise_us', 'Wise · US bank', b.us_bank_partners || 0]"));
    assert.ok(read('privacy.html').includes('US bank account name, routing number, account number and type'));
    const page = read('partner-content.html');
    assert.ok(page.includes('value="us_bank"') && page.includes("routingNumber: v('pt-us-routing')"));
    assert.ok(page.includes('<select id="pt-us-holder" class="mt-1 block w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"><option value="">Choose…</option>'), 'no silent default to business');
});

check('Partner Terms 1.3: 4.2 names US bank via Wise in USD; everyone re-accepts', () => {
    const terms = read('partner-terms.html');
    assert.ok(terms.includes('or transfer through Wise to a US bank account or a euro bank account (by IBAN)'));
    assert.ok(terms.includes('Wise converts the sterling amount to US dollars or euros'));
    assert.ok(terms.includes('Version 1.3 &middot; Last updated: 23 November 2026'));
    assert.ok(read('src/config/partner-terms.ts').includes("PARTNER_TERMS_VERSION = '1.3'"), 'bumped, so the Partner page asks again');
});

console.log('Euro bank accounts (IBAN) — owner, 2026-11-23: "Yes, add EUR"');

// Published example IBANs (ECB / bank documentation); not anyone's account.
const eur = { method: 'eu_bank', accountName: 'Example GmbH', holderType: 'business', iban: 'de89 3704 0044 0532 0130 00', bic: 'cobadeffxxx' };

check('IBAN check digits (mod 97) catch typos; BIC format checked, optional', () => {
    for (const ok of ['DE89370400440532013000', 'FR1420041010050500013M02606', 'NL91ABNA0417164300', 'IE29AIBK93115212345678']) assert.ok(isValidIban(ok), ok);
    assert.ok(!isValidIban('DE89370400440532013001'), 'one digit off');
    assert.ok(!isValidIban('DE8937040044'), 'too short');
    assert.ok(isValidBic('COBADEFFXXX') && isValidBic('COBADEFF') && !isValidBic('COBA-DE'));
});

check('a euro account is accepted and tidied; bad IBAN / BIC / missing holder get plain errors', () => {
    const r = validatePayoutDetails(eur);
    assert.ok(r.ok && r.value.method === 'eu_bank' && r.value.iban === 'DE89370400440532013000' && r.value.bic === 'COBADEFFXXX');
    const noBic = validatePayoutDetails({ ...eur, bic: '' });
    assert.ok(noBic.ok && noBic.value.method === 'eu_bank' && noBic.value.bic === null, 'BIC can be blank');
    const err = (patch: Record<string, unknown>) => { const x = validatePayoutDetails({ ...eur, ...patch }); return x.ok ? '' : x.error; };
    assert.match(err({ iban: 'DE00370400440532013000' }), /IBAN/);
    assert.match(err({ bic: 'NOPE' }), /BIC/);
    assert.match(err({ holderType: '' }), /personally or to a business/);
    assert.match(err({ iban: 'GB82WEST12345698765432' }), /UK IBAN/, 'UK accounts use the UK bank option');
    assert.match(err({ iban: 'CH9300762011623852957' }), /euro-area/, 'a valid Swiss IBAN holds francs, not euros');
    assert.strictEqual(err({ iban: 'BG80BNBG96611020345678' }), '', 'Bulgaria uses the euro (since 1 Jan 2026)');
    assert.ok(PAYOUT_METHODS.includes('eu_bank' as any));
});

check('masked: country and last 4 only', () => {
    const r = validatePayoutDetails(eur); assert.ok(r.ok);
    if (r.ok) { const m = maskPayoutDetails(r.value); assert.strictEqual(m, 'Euro bank · Example GmbH · DE** ****3000'); assert.ok(!m.includes('37040044')); }
});

check('Wise · euro bank file: Wise’s header + IBAN, BIC; GBP → EUR; only IBAN/BIC filled', () => {
    const r = validatePayoutDetails(eur); assert.ok(r.ok);
    const f = buildExport('wise_eur', 9, [{ partnerId: 1, name: 'E', email: 'e@example.com', amountPence: 4200, details: r.ok ? r.value : null }]);
    const [head, row] = f.csv.trim().split('\r\n');
    // Exactly the header of Wise's template with EUR rows (downloaded 2026-11-23).
    assert.strictEqual(head, 'name,recipientEmail,paymentReference,referenceNumber,receiverType,amountCurrency,amount,sourceCurrency,targetCurrency,sortCode,accountNumber,type,abartn,accountType,addressCountryCode,addressFirstLine,addressCity,addressState,addressPostCode,IBAN,BIC');
    const cells = row.split(','); const at = (h: string) => cells[WISE_EUR_HEADERS.indexOf(h)];
    assert.strictEqual(cells.length, WISE_EUR_HEADERS.length);
    assert.deepStrictEqual([at('receiverType'), at('amountCurrency'), at('amount'), at('sourceCurrency'), at('targetCurrency'), at('IBAN'), at('BIC')], ['INSTITUTION', 'source', '42.00', 'GBP', 'EUR', 'DE89370400440532013000', 'COBADEFFXXX']);
    for (const h of ['sortCode', 'accountNumber', 'type', 'abartn', 'accountType', 'addressCountryCode', 'addressFirstLine']) assert.strictEqual(at(h), '', h);
});

check('UK bank asks personal or business → PERSON / INSTITUTION; older saved details default to PERSON', () => {
    const base = { method: 'bank', accountName: 'Ann Ltd', sortCode: '11-22-33', accountNumber: '01234567' };
    assert.ok(!validatePayoutDetails(base).ok, 'must choose');
    const biz = validatePayoutDetails({ ...base, holderType: 'business' }); assert.ok(biz.ok);
    const old = { method: 'bank' as const, accountName: 'Old', sortCode: '112233', accountNumber: '01234567' };   // saved before holderType existed
    const f = buildExport('wise_bank', 1, [
        { partnerId: 1, name: 'A', email: 'a@x.com', amountPence: 100, details: biz.ok ? biz.value : null },
        { partnerId: 2, name: 'O', email: 'o@x.com', amountPence: 100, details: old },
    ]).csv.trim().split('\r\n');
    const rt = WISE_BANK_HEADERS.indexOf('receiverType');
    assert.strictEqual(f[1].split(',')[rt], 'INSTITUTION');
    assert.strictEqual(f[2].split(',')[rt], 'PERSON');
});

check('wired: SQL allows eu_bank; admin can download; privacy + form', () => {
    assert.ok(read('db/z-partner-eu-bank.sql').includes("CHECK (payout_method IN ('wise', 'paypal', 'bank', 'us_bank', 'eu_bank'))"));
    assert.ok(read('db/schema.ts').includes("IN ('wise','paypal','bank','us_bank','eu_bank')"));
    assert.ok(read('netlify/functions/admin-partners.ts').includes("'wise_eur'"));
    assert.ok(read('admin.html').includes("['wise_eur', 'Wise · euro bank', b.eu_bank_partners || 0]"));
    assert.ok(read('privacy.html').includes('a euro bank account name, IBAN and (optionally) BIC'));
    const page = read('partner-content.html');
    assert.ok(page.includes('value="eu_bank"') && page.includes("iban: v('pt-eu-iban')") && page.includes("holderType: v('pt-uk-holder')"));
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
