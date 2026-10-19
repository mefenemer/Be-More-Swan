// tests/partner-codes.test.ts
// Affiliate Partner Programme, step 7 — partner codes (docs/affiliate-partner-programme-plan.md §4.2).
//
// WHY THIS EXISTS (2026-10-18). Owner decision: a partner's memorable code is a BMS code, NOT a
// Stripe promotion code — a promotion code is tied to one coupon, so a monthly "100% off once" code
// used on an annual plan would give away a year. So: one resolver for every code, the offer always
// decided server-side from user_referrals (the right coupon per billing cycle), and the plan picker's
// "Have an invite code?" trusting the server, not a ?ref in the URL. SQL: tests/partner-codes-db.test.ts.
//
// Run:  npx tsx tests/partner-codes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePartnerCode } from '../src/utils/invite-codes';
import { proposePartnerCode } from '../src/utils/partner-ops-proposals';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

check('partner codes: 4–20 letters/numbers starting with a letter, stored upper case', () => {
    assert.deepStrictEqual(validatePartnerCode(' samSwan '), { ok: true, code: 'SAMSWAN' });
    for (const bad of ['SAM', '1SAM', 'SAM SWAN', 'SAM-SWAN', 'A'.repeat(21), '']) assert.strictEqual(validatePartnerCode(bad).ok, false, bad);
});

check('never a Stripe promotion code or coupon', () => {
    for (const f of ['src/utils/invite-codes.ts', 'netlify/functions/referral-claim.ts']) {
        assert.ok(!/promotionCodes|coupons\.create|stripe/i.test(read(f).replace(/Stripe promotion code/g, '')), f);
    }
});

check('every place that reads a code uses the one resolver', () => {
    assert.ok(read('netlify/functions/register.ts').includes('const invite = await resolveInviteCode(db, referralRef);'));
    assert.ok(read('netlify/functions/invite-lookup.ts').includes('const invite = await resolveInviteCode(db, code);'));
    assert.ok(read('netlify/functions/get-referral-discount.ts').includes('const referrer = await resolveInviteCode(db, ref);'));
    assert.ok(read('src/utils/invite-codes.ts').includes("eq(partners.status, 'approved')"), 'only approved partners\' codes work');
});

check('checkout still decides the offer from the database, not the browser', () => {
    const co = read('netlify/functions/create-plan-checkout-intent.ts');
    assert.ok(co.includes('const referralOffer = await findReferralOffer(db, user.id);'));
    assert.ok(co.includes('sessionParams.discounts = [{ coupon: await resolveReferralCouponId(stripe, billingCycle) }];'));
});

check('"Have an invite code?": asks the server, hidden unless eligible, writes only via referral-claim', () => {
    const ws = read('workspace.html');
    assert.ok(ws.includes('<div id="plan-gate-invite" class="hidden max-w-md mx-auto text-left" style="display:none">'));
    assert.ok(ws.includes("const st = await (await fetch('/.netlify/functions/referral-claim', { credentials: 'same-origin' })).json();"));
    assert.ok(ws.includes('const show = !!st.eligible;'));
    const claim = read('netlify/functions/referral-claim.ts');
    assert.ok(claim.includes("checkImpersonationBlock(event, 'referral_claim')"));
    assert.ok(claim.includes("checkRateLimit(db, 'referral_claim'"));
});

check('the late code follows the friend-offer rules: not yours, not already invited, never paid', () => {
    const lib = read('src/utils/invite-codes.ts');
    const fn = lib.slice(lib.indexOf('export async function claimLateReferral'));
    assert.ok(fn.includes('invite.referrerUserId === userId'));
    assert.ok(fn.includes('notInArray(plans.planType, [...FREE_PLAN_TYPES])'));
    assert.ok(fn.includes('.onConflictDoNothing()'));
});

check('admin sets / changes / turns off a code (audited), and the chat has the same card', () => {
    const api = read('netlify/functions/admin-partners.ts');
    assert.ok(api.includes("if (body.action === 'partner_code') {") && api.includes("await audit('partner_code_change'"));
    const html = read('admin.html');
    assert.ok(html.includes('async function partnerSetCode(') && html.includes('async function partnerClearCode('));
    assert.ok(read('netlify/functions/admin-partners-chat.ts').includes("case 'propose_partner_code': return offer(proposePartnerCode("));
    const partners = [{ id: 1, status: 'approved', name: 'Sam', email: null }, { id: 2, status: 'suspended', name: 'Sue', email: null }];
    assert.deepStrictEqual((proposePartnerCode(partners, { partnerId: 1, code: 'samswan' }) as any).card.request, { action: 'partner_code', partnerId: 1, code: 'SAMSWAN' });
    assert.deepStrictEqual((proposePartnerCode(partners, { partnerId: 2, code: null }) as any).card.request, { action: 'partner_code', partnerId: 2, code: null });
    assert.match((proposePartnerCode(partners, { partnerId: 2, code: 'SUESWAN' }) as any).error, /approved/);
});

check('the partner sees their code on their Partner page', () => {
    assert.ok(read('netlify/functions/partner-hub.ts').includes("partnerCode: p.status === 'approved' ? p.promoCode : null,"));
    assert.ok(read('partner-content.html').includes('id="pt-partner-code"'));
});

check('the ledger records a customer who came in on the partner code', () => {
    assert.ok(read('src/utils/partner-ledger.ts').includes("viaPartnerCode ? 'promo_code' : 'link'"));
});

console.log(`\n${passed} passed`);
