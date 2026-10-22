// tests/partner-legal-data.test.ts
// Affiliate Partner Programme, step 9 — Partner Terms, the Terms and privacy updates, data export,
// erasure and partner notifications (docs/affiliate-partner-programme-plan.md §4.8).
//
// WHY THIS EXISTS (2026-10-19). These are promises to real people: what partners agree to, what we
// tell everyone about their data, and what happens when someone asks us to forget them. Owner
// decision: the customer Terms only POINT to the Partner Terms — no version bump, so no re-acceptance
// prompt for every customer. Erasure keeps the commission ledger (tax law, 7 years) but nothing that
// identifies the partner, and the payout details leave the vault. SQL: tests/partner-erasure-db.test.ts.
//
// Run:  npx tsx tests/partner-legal-data.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTNER_TERMS_VERSION, PARTNER_TERMS_UPDATED } from '../src/config/partner-terms';
import { getTemplateDefault } from '../src/utils/email-templates-catalog';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('Partner Terms');
const terms = read('partner-terms.html');

check('the page states the version and date the code records, and stays out of the index until launch', () => {
    assert.ok(terms.includes(`Version ${PARTNER_TERMS_VERSION} &middot; Last updated: ${PARTNER_TERMS_UPDATED}`));
    // Public since the programme opened: indexed, canonical, in the sitemap and linked from the footer.
    assert.ok(!terms.includes('noindex'), 'partner terms are public');
    assert.ok(terms.includes('<link rel="canonical" href="https://bemoreswan.com/partner-terms">'));
    const relative = [...terms.matchAll(/(?:href|src)=["'](?!\/|https?:|#|mailto:)([^"']+)["']/g)].map((m) => m[1]);
    assert.deepStrictEqual(relative, []);
});

check('it says what we decided: ad labels, no voucher sites, rates fixed per customer, holding period, minimum, forfeit on fraud', () => {
    for (const phrase of ['clearly identifiable as advertising', 'coupon, voucher, deal or cashback sites', 'a change never reduces the rate, or increases the cost deduction, on customers who have already paid', 'Commission is worked out after costs',
        'holding period', 'currently £50', 'forfeited', 'excluding VAT', 'England and Wales']) {
        assert.ok(terms.includes(phrase), `missing: ${phrase}`);
    }
});

check('applying requires accepting them, and the version is recorded', () => {
    const page = read('partners.html');
    assert.ok(page.includes('id="pa-terms"') && page.includes('href="/partner-terms.html"') && page.includes("acceptTerms: document.getElementById('pa-terms').checked,"));
    const lib = read('src/utils/partner-applications.ts');
    assert.ok(lib.includes("if (raw.acceptTerms !== true) return { ok: false, error: 'Please read and accept the Partner Terms.' };"));
    assert.ok(lib.includes('termsVersion: PARTNER_TERMS_VERSION, termsAcceptedAt: new Date(),'));
});

check('partners who have not accepted the current version are asked on their Partner page', () => {
    const hub = read('netlify/functions/partner-hub.ts');
    assert.ok(hub.includes('partnerTerms: { accepted: p.termsVersion === PARTNER_TERMS_VERSION'));
    assert.ok(hub.includes("if (body.action === 'accept_terms') {"));
    assert.ok(read('partner-content.html').includes('id="pt-terms-banner"'));
});

console.log('customer Terms and privacy policy');

check('the Terms point to the Partner Terms WITHOUT a version bump (owner decision: no re-acceptance)', () => {
    const tos = read('terms_of_service.html');
    assert.ok(tos.includes('<strong>1.4 — Partner programme.</strong>') && tos.includes('href="./partner-terms.html"'));
    assert.ok(tos.includes('Version 2.2 &middot;'), 'version unchanged');
    assert.match(read('netlify/functions/accept-tos.ts'), /CURRENT_TOS_VERSION\s*=\s*['"]2\.2['"]/);
});

check('the privacy policy covers partners, invited people, payout details in the vault, and the retention rows', () => {
    const pp = read('privacy.html');
    for (const phrase of ['If you are a Be More Swan partner', 'If someone invited you', 'held encrypted in our secrets vault', 'with no IP address and nothing stored on the visitor\'s device',
        '“Customer 3”', 'the first name of the person who shared it', 'Partner applications we decline', '12 months after the decision', 'Partner commission and payout records']) {
        assert.ok(pp.includes(phrase), `missing: ${phrase}`);
    }
    assert.ok(!pp.includes('The last three rows above survive it'), 'stale summary sentence');
});

console.log('export, erasure, deletion');

check('the export includes the partner\'s own record and money, and only a COUNT of their customers', () => {
    const ex = read('src/utils/workspace-export.ts');
    assert.ok(ex.includes('const [partnerRow] = await rowsWhere(db, s.partners, eq(s.partners.userId, userId));'));
    assert.ok(ex.includes('customersIntroduced: (await db.select({ id: s.partnerReferrals.id })'));
    assert.ok(ex.includes('    const you = {\n        partner,'));
});

check('every path that removes a user erases partner data first', () => {
    const del = read('src/utils/user-deletion.ts');
    assert.ok(del.indexOf('await erasePartnerDataForUser(tx, userId);') < del.indexOf('.delete(users)'));
    const exec = read('netlify/functions/account-delete-execute.ts');
    assert.ok(exec.indexOf('await erasePartnerDataForUser(db, user.id)') < exec.indexOf('await db.delete(users).where(eq(users.id, user.id))'));
    assert.ok(read('netlify/functions/admin-gdpr-erase.ts').includes('const partnerErasure = await erasePartnerDataForUser(db, targetUserId)'));
});

check('erasure removes the vault payout details and identifying fields, but never the ledger', () => {
    const er = read('src/utils/partner-erasure.ts');
    const fn = er.slice(er.indexOf('export async function erasePartnerRow'), er.indexOf('export async function erasePartnerDataForUser'));
    assert.ok(fn.includes('await deleteSecret(db, payoutRefKey(partnerId));') && fn.includes('await deleteSecret(db, pendingPayoutRefKey(partnerId));'));
    assert.ok(fn.includes('applicantName: null, applicantEmail: null'));
    assert.ok(!/partnerCommissions/.test(fn), 'the commission ledger must survive (tax law)');
});

check('declined applications are purged nightly after 12 months; an admin (or chat card) can erase one sooner', () => {
    assert.ok(read('netlify/functions/partner-commission-sweep.ts').includes('await purgeDeclinedApplications(db, now);'));
    assert.ok(read('netlify/functions/admin-partners.ts').includes("if (body.action === 'erase_application') {"));
    assert.ok(read('admin.html').includes('async function partnerEraseApplication('));
    assert.ok(read('netlify/functions/admin-partners-chat.ts').includes("case 'propose_erase_application':"));
});

console.log('notifications');

check('commission earned and payout sent — in-app (opening the Partner page) and by email', () => {
    for (const k of ['partner_commission_earned', 'partner_payout_sent']) assert.ok(getTemplateDefault(k)?.transactional, `email ${k}`);
    const cat = read('src/utils/notification-templates-catalog.ts');
    assert.ok(cat.includes("templateKey: 'partner_commission_earned'") && cat.includes("templateKey: 'partner_payout_sent'"));
    assert.ok(read('notifications.js').includes("if (meta.action === 'partner_page')  return { label: 'Open Partner page', run: go('partner') };"));
});

check('earned is sent once per commission (after a successful insert); paid is sent when a run is marked paid', () => {
    const led = read('src/utils/partner-ledger.ts');
    assert.ok(led.indexOf("if (!inserted.length) return { recorded: false, reason: 'duplicate' };") < led.indexOf('await notifyCommissionEarned(db, ref.partnerId, amount, availableAt);'));
    assert.ok(read('netlify/functions/admin-partners.ts').includes("const notified = body.action === 'mark_paid' ? await notifyPayoutSent(db, batchId) : 0;"));
    assert.ok(/catch \(err\) \{\s*console\.error\('\[partner-notify\]/.test(read('src/utils/partner-notify.ts')), 'never throws');
});

console.log(`\n${passed} passed`);
