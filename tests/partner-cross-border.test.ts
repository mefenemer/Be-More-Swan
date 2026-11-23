// tests/partner-cross-border.test.ts
// Partner Terms 1.3 after the UK / EU / US legal and financial reviews (2026-11-23). Pins the code the new
// wording promises: payouts never held for a newer version (8.1), leavers' run-off (7.4(a)), declined
// changes (8.1), 180-day clawback (4.3), sterling conversion and pro rata (3.2), annual 60-day hold (4.1),
// the acceptance log and copy email (1.2), country / joining-as (2.1), no IP kept (privacy), UK VAT on top
// and self-billed statements (4.5), and the sanctions reminders (4.6).
//
// Run:  npx tsx tests/partner-cross-border.test.ts

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOffAllows, RUN_OFF_REASONS } from '../src/utils/partner-activity';
import { isAnnualPeriod, isPastClawbackWindow, proRataPence, ANNUAL_HOLDING_DAYS, CLAWBACK_WINDOW_DAYS } from '../src/utils/partner-ledger';
import { buildExport, type BatchLine } from '../src/utils/partner-payout-batches';
import { isUkVatNumber, isUkVatRegistered, normaliseVatNumber, statementHtml, statementNumber, vatPenceFor } from '../src/utils/partner-statements';
import { DECLINED_CHANGE_DAYS, PARTNER_TERMS_EFFECTIVE, PARTNER_TERMS_VERSION } from '../src/config/partner-terms';
import { frozenTermsPath } from '../src/utils/partner-terms-acceptance';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const d = (s: string) => new Date(`${s}T00:00:00Z`);

console.log('ending and run-off (7.4, 8.1)');
check('leaving, declining a change, inactivity and closure all keep the run-off; breach and other do not', () => {
    assert.deepStrictEqual([...RUN_OFF_REASONS].sort(), ['change_declined', 'closure', 'inactivity', 'left']);
    for (const r of RUN_OFF_REASONS) assert.ok(runOffAllows(r, d('2027-08-01'), 12, d('2028-06-01')), r);
    for (const r of ['breach', 'other']) assert.ok(!runOffAllows(r, d('2027-08-01'), 12, d('2027-08-02')), r);
});
check('payouts wait only for a partner who never accepted any version (8.1: earned commission never held back)', () => {
    const b = read('src/utils/partner-payout-batches.ts');
    assert.ok(b.includes(": !r.terms_version ? `Hasn’t accepted the Partner Terms"));
    assert.ok(!b.includes('hasAcceptedCurrentTerms'));
});
check('a declined change ends the partnership 60 days after the version took effect, as change_declined', () => {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(PARTNER_TERMS_EFFECTIVE));
    assert.strictEqual(DECLINED_CHANGE_DAYS, 60);
    const a = read('src/utils/partner-activity.ts');
    const fn = a.slice(a.indexOf('export async function endDeclinedChanges'));
    assert.ok(fn.includes("end_reason = 'change_declined'"));
    assert.ok(fn.includes('terms_version IS NOT NULL AND terms_version <> ${PARTNER_TERMS_VERSION}'), 'never-accepted partners are untouched');
    assert.ok(read('netlify/functions/partner-commission-sweep.ts').includes('await endDeclinedChanges(db, now)'));
    assert.ok(read('db/z-partner-terms-cross-border.sql').includes("'inactivity', 'closure', 'left', 'change_declined', 'breach', 'other'"));
});
check('admin and Partner Ops describe the leaver run-off', () => {
    assert.ok(read('admin.html').includes("Partner Terms 7.1 / 7.4(a) — standard 12-month customers keep earning them commission to term"));
    assert.ok(read('src/utils/partner-ops-proposals.ts').includes('If they left or the programme is closing (Terms 7.4(a))'));
});

console.log('money (3.2, 4.1, 4.3)');
check('a refund or dispute more than 180 days after the payment leaves commission alone', () => {
    assert.strictEqual(CLAWBACK_WINDOW_DAYS, 180);
    assert.ok(!isPastClawbackWindow(d('2027-01-01'), d('2027-06-29')));
    assert.ok(isPastClawbackWindow(d('2027-01-01'), d('2027-07-01')));
    assert.ok(read('src/utils/partner-ledger.ts').includes('if (isPastClawbackWindow(row.createdAt, at)) continue;'));
});
check('a payment covering months beyond the commission period earns only on the months inside it', () => {
    // Annual payment starting 1 month before a 12-month window ends: 1/12 of it counts (rounded down).
    const start = d('2027-12-01'), end = d('2028-12-01'), windowEnd = d('2028-01-01');
    const part = proRataPence(60720, start, end, windowEnd);
    assert.ok(part > 5000 && part < 5200, String(part));
    assert.strictEqual(proRataPence(6900, d('2027-05-01'), d('2027-06-01'), d('2028-01-01')), 6900, 'inside the window: full');
    assert.strictEqual(proRataPence(6900, null, null, d('2028-01-01')), 6900, 'unknown period: full');
    assert.strictEqual(proRataPence(6900, start, end, null), 6900, 'lifetime: full');
});
check('annual payments are held 60 days', () => {
    assert.strictEqual(ANNUAL_HOLDING_DAYS, 60);
    assert.ok(isAnnualPeriod(d('2027-01-01'), d('2028-01-01')));
    assert.ok(!isAnnualPeriod(d('2027-01-01'), d('2027-02-01')));
    const w = read('netlify/functions/stripe-webhook.ts');
    assert.strictEqual((w.match(/annual:\s+billingCycle === 'annual'/g) || []).length, 2, 'both first-payment paths flag annual');
    assert.ok(w.includes('...getInvoicePaidPeriod(invoice),'));
});
check('another currency counts at the sterling amount Stripe settled it into; unknown = not recorded, logged', () => {
    const l = read('src/utils/partner-ledger.ts');
    assert.ok(l.includes('netPence = payment.gbpNetAmountPence;'));
    assert.ok(l.includes('NOT recorded, record it by hand'));
    const w = read('netlify/functions/stripe-webhook.ts');
    assert.ok(w.includes("expand: ['latest_charge.balance_transaction']") && w.includes("bt.currency !== 'gbp'"));
    assert.ok(w.includes('Math.round((bt.amount * payment.netAmountPence) / charge.amount)'));
    // Refunds reduce commission by the refunded SHARE, so a foreign-currency refund works on a sterling row.
    assert.ok(w.includes("'refund', new Date(stripeEvent.created * 1000), charge.amount ?? null)"));
});

console.log('records and privacy (1.2, 2.1)');
check('every acceptance is logged (append-only) and the partner is emailed a copy linking the frozen version', () => {
    assert.ok(read('db/z-partner-terms-cross-border.sql').includes('CREATE TABLE IF NOT EXISTS partner_terms_acceptances'));
    assert.ok(read('src/utils/partner-applications.ts').includes("channel: 'application'"));
    assert.ok(read('netlify/functions/partner-hub.ts').includes("channel: 'partner_page'"));
    assert.ok(read('src/utils/email-templates-catalog.ts').includes("triggerKey: 'partner_terms_accepted'"));
    assert.strictEqual(frozenTermsPath('1.3'), '/partner-terms-v1.3.html');
});
check('the frozen copy of the current version exists and matches the live Terms', () => {
    const frozen = join(root, `partner-terms-v${PARTNER_TERMS_VERSION}.html`);
    assert.ok(existsSync(frozen), `create partner-terms-v${PARTNER_TERMS_VERSION}.html as a copy of partner-terms.html`);
    assert.strictEqual(readFileSync(frozen, 'utf8'), read('partner-terms.html'), 'the frozen copy has drifted from the live Terms');
});
check('no visitor IP is stored with click counts: the rate-limit key is a keyed hash', () => {
    const f = read('netlify/functions/invite-lookup.ts');
    assert.ok(f.includes("checkRateLimit(db, 'invite_click', `${visitorKey(ip)}:${partner.id}`"));
    assert.ok(!f.includes('`${ip}:${partner.id}`'));
});

console.log('VAT and statements (4.5), sanctions (4.6)');
check('UK VAT numbers are recognised; only a UK-VAT-registered partner gets 20% on top', () => {
    assert.strictEqual(normaliseVatNumber(' gb 123 456 789 '), 'GB123456789');
    assert.strictEqual(normaliseVatNumber('nope!'), null);
    assert.ok(isUkVatNumber('GB123456789') && isUkVatNumber('XI123456789') && !isUkVatNumber('DE123456789'));
    assert.ok(isUkVatRegistered({ vat_registered: true, vat_number: 'GB123456789' }));
    assert.ok(!isUkVatRegistered({ vat_registered: true, vat_number: 'IE1234567T' }));
    assert.strictEqual(vatPenceFor(1380, true), 276);
    assert.strictEqual(vatPenceFor(1380, false), 0);
    assert.strictEqual(vatPenceFor(-500, true), 0);
});
check('the payment file sends commission + VAT', () => {
    const lines: BatchLine[] = [{ partnerId: 1, name: 'Ann', email: 'a@x.com', amountPence: 5000, vatPence: 1000, details: { method: 'paypal', email: 'ann@x.com' } as any }];
    const out = buildExport('paypal', 7, lines);
    assert.ok(out.csv.includes('ann@x.com,60.00,GBP'));
    assert.strictEqual(out.totalPence, 6000);
});
check('the statement shows our details, each line, VAT for UK-registered and the right VAT note', () => {
    const base = { number: statementNumber(7, 3), date: '2027-02-28', partnerName: 'Ann <b>', partnerEmail: 'a@x.com',
        lines: [{ date: '2027-01-05', label: 'Commission — Customer 1', paymentPence: 6900, commissionPence: 1380 }] };
    const uk = statementHtml({ ...base, vatNumber: 'GB123456789', ukVat: true, subtotalPence: 1380, vatPence: 276, totalPence: 1656 });
    assert.ok(uk.includes('BMS-SB-7-3') && uk.includes('17378263') && uk.includes('Great Portland Street'));
    assert.ok(uk.includes('Self-billed invoice — the VAT shown is your output tax due to HMRC.'));
    assert.ok(uk.includes('£2.76') && uk.includes('£16.56') && uk.includes('Ann &lt;b&gt;'));
    const abroad = statementHtml({ ...base, vatNumber: null, ukVat: false, subtotalPence: 1380, vatPence: 0, totalPence: 1380 });
    assert.ok(abroad.includes('Reverse charge: the customer accounts for any UK VAT') && !abroad.includes('UK VAT at 20%'));
});
check('the Partner page lists statements and takes a VAT number; the hub only serves the partner\'s own paid batches', () => {
    const page = read('partner-content.html');
    assert.ok(page.includes('id="pt-statements"') && page.includes('?view=statement&batchId=') && page.includes("action: 'vat_number'"));
    const hub = read('netlify/functions/partner-hub.ts');
    assert.ok(hub.includes("event.queryStringParameters?.view === 'statement'") && hub.includes('await loadStatement(db, p.id, batchId)'));
    assert.ok(read('src/utils/partner-statements.ts').includes("WHERE b.id = ${batchId} AND b.status = 'paid' AND p.id = ${partnerId}"));
});
check('admin is reminded to check sanctions lists before approving and paying', () => {
    const a = read('admin.html');
    assert.ok((a.match(/Check the partner against the UK Sanctions List and OFAC SDN before approving\/paying/g) || []).length >= 3);
});

console.log(`\n${passed} passed`);
