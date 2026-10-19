// tests/partner-hub.test.ts
// Affiliate Partner Programme, step 5 — the partner's Partner page in the workspace
// (docs/affiliate-partner-programme-plan.md §4.6).
//
// WHY THIS EXISTS (2026-10-18). Owner decision: the hub lives INSIDE the workspace, and a partner
// needs no paid plan — so the plan picker, which hard-gates the whole workspace once a trial ends,
// must never lock a partner out of it. And where a partner is paid is what an account thief would
// change: a change must wait for an emailed confirmation, made while signed in, and full details must
// never reach a browser. The payout SQL + vault flow is proven in tests/partner-payouts-db.test.ts.
//
// Run:  npx tsx tests/partner-hub.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskPayoutDetails, validatePayoutDetails } from '../src/utils/partner-payouts';
import { getTemplateDefault } from '../src/utils/email-templates-catalog';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('payout details');

check('PayPal and Wise take an email; a UK bank takes name, 6-digit sort code, 8-digit account number', () => {
    assert.deepStrictEqual(validatePayoutDetails({ method: 'paypal', email: ' Jo@Example.com ' }), { ok: true, value: { method: 'paypal', email: 'jo@example.com' } });
    assert.deepStrictEqual(validatePayoutDetails({ method: 'bank', accountName: 'Jo Example', sortCode: '12-34-56', accountNumber: '1234 5678' }),
        { ok: true, value: { method: 'bank', accountName: 'Jo Example', sortCode: '123456', accountNumber: '12345678' } });
    assert.match((validatePayoutDetails({ method: 'wise', email: 'nope' }) as any).error, /Wise/);
    assert.match((validatePayoutDetails({ method: 'bank', accountName: 'Jo', sortCode: '1234', accountNumber: '12345678' }) as any).error, /sort code/);
    assert.match((validatePayoutDetails({ method: 'bank', accountName: 'Jo', sortCode: '123456', accountNumber: '123' }) as any).error, /8 digits/);
    assert.match((validatePayoutDetails({ method: 'crypto' }) as any).error, /PayPal, Wise or a UK bank/);
});

check('only a masked summary is ever shown', () => {
    assert.strictEqual(maskPayoutDetails({ method: 'paypal', email: 'jo@example.com' }), 'PayPal · j***@example.com');
    assert.strictEqual(maskPayoutDetails({ method: 'bank', accountName: 'Jo Example', sortCode: '123456', accountNumber: '12345678' }), 'UK bank · Jo Example · ****5678');
});

check('the hub API never reads full details, and an admin impersonating cannot change them', () => {
    const hub = read('netlify/functions/partner-hub.ts');
    assert.ok(!/getPayoutDetails|getSecret/.test(hub), 'partner-hub.ts must never load the real payout details');
    assert.ok(hub.includes("if (impersonating) return json(403"));
    assert.ok(hub.includes('confirmPayoutChange(db, p.id, String(body.token'), 'a token only confirms for the signed-in partner\'s own row');
    assert.ok(hub.includes("checkRateLimit(db, 'partner_payout_change'"));
});

check('the confirm link opens the signed-in Partner page — it never confirms on open', () => {
    const lib = read('src/utils/partner-payouts.ts');
    assert.ok(lib.includes('/workspace.html?view=partner&payoutToken='));
    const ws = read('workspace.html');
    assert.ok(ws.includes("if (viewParam === 'partner' && payoutTokenParam && /^[A-Za-z0-9_-]{20,100}$/.test(payoutTokenParam)) window._partnerPayoutToken = payoutTokenParam;"));
    assert.ok(read('partner-content.html').includes("post({ action: 'confirm_payout', token: window._partnerPayoutToken })"), 'confirmation is a button press');
});

check('details live in the vault; the old encrypted column is never written', () => {
    const lib = read('src/utils/partner-payouts.ts');
    assert.ok(lib.includes('storeSecret(db as never, pendingPayoutRefKey(partnerId)'));
    assert.ok(!/payoutDetailsEnc|encryptCredential/.test(lib));
});

check('both payout emails exist', () => {
    assert.ok(getTemplateDefault('partner_payout_confirm')?.bodyHtml.includes('{{link.action_url}}'));
    assert.ok(getTemplateDefault('partner_payout_changed')?.bodyHtml.includes('{{partner.payout_display}}'));
});

console.log('never locked out by the plan picker');
const ws = read('workspace.html');

check('check-capacity reports partner status, and a failed lookup can never break it', () => {
    const cap = read('netlify/functions/check-capacity.ts');
    assert.ok(cap.includes('partnerStatus,'));
    const at = cap.indexOf('let partnerStatus: string | null = null;');
    assert.ok(at > 0 && cap.slice(at, at + 600).includes('} catch (err) {'), 'the partner lookup must be wrapped');
});

check('an approved or suspended partner with no plan goes to the Partner page, never the hard plan gate', () => {
    const gate = ws.indexOf("const partnerNeverGated = partnerStatus === 'approved' || partnerStatus === 'suspended';");
    const exempt = ws.indexOf('if (!planActivated && cap?.noPlan && partnerNeverGated) {');
    const hard = ws.indexOf("} else if (!planActivated && cap?.noPlan && (selectPlanRequested || (cap?.assistantCount ?? 0) === 0 || cap?.trialEnded)) {");
    assert.ok(gate > 0 && exempt > gate && hard > exempt, 'the partner exemption must come before the hard gate, as its else-branch');
    assert.ok(ws.slice(exempt, hard).includes("await loadView('partner')"));
});

check('the Partner page is a workspace view, and its sidebar link is hidden until we know they are a partner', () => {
    assert.ok(ws.includes("'partner': { file: 'partner-content.html', title: '| Partner' },"));
    assert.ok(ws.includes("'partner': document.getElementById('nav-partner'),"));
    const side = read('components/sidebar.html');
    assert.ok(/<a href="#" id="nav-partner" class="hidden [^"]*" style="display:none">/.test(side));
    assert.ok(ws.includes("if (navPartner && ['applied', 'approved', 'suspended'].includes(partnerStatus)) {"));
});

check('"Partner" is translated in every locale', () => {
    for (const lang of ['en', 'de', 'es', 'fr', 'pt']) {
        const j = JSON.parse(read(`locales/${lang}.json`));
        assert.ok(j.workspace?.nav?.partner, `${lang} has no workspace.nav.partner`);
    }
});

console.log('the page');
const page = read('partner-content.html');

check('customers are never named to the partner', () => {
    const ops = read('src/utils/partner-ops.ts');
    const fn = ops.slice(ops.indexOf('export async function partnerHubSummary'));
    assert.ok(!/email|first_name|last_name/.test(fn), 'the hub query must not select who the customers are');
    assert.ok(read('netlify/functions/partner-hub.ts').includes('`Customer ${c.customer_no}`'));
});

check('grid and flex panels that start hidden are hidden inline too (hidden loses to display utilities)', () => {
    assert.ok(page.includes('id="pt-f-bank" class="hidden grid grid-cols-1 sm:grid-cols-3 gap-3" style="display:none"'));
    assert.ok(page.includes('flex items-center justify-between gap-3 flex-wrap" style="display:none"'));
});

check('Refer a Friend sends partners to their Partner page (their code earns cash, not tokens)', () => {
    const ref = read('referral-content.html');
    const partnerCheck = ref.indexOf("if (cap && (cap.partnerStatus === 'approved' || cap.partnerStatus === 'suspended')) {");
    const fetchReferral = ref.indexOf('const res = await fetch(`${BASE}/referral`);');
    assert.ok(partnerCheck > 0 && fetchReferral > partnerCheck, 'decide before loading the token vault');
    assert.ok(ref.includes('id="ref-partner-state"'));
});

check('the no-plan upsell opens the dismissible plan picker, never the hard gate', () => {
    assert.ok(page.includes('window.openPlanSelection && window.openPlanSelection()'));
    assert.ok(ws.includes("window.openPlanSelection = (referralCode) => showGate(referralCode || null, { hard: false });"));
});

console.log(`\n${passed} passed`);
