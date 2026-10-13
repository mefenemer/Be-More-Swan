// tests/admin-coupons.test.ts
// Admin → Revenue → Coupons: coupons made in Be More Swan are real Stripe coupons, and nothing an
// admin can type reaches Stripe in a shape it would reject halfway through.
//
// No database, no Stripe: the pure rules in src/utils/coupon-rules.ts, plus source checks on the
// function, the admin page, checkout and the promo preview.
// Run:  npx tsx tests/admin-coupons.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCouponInput, stripeCouponParams, stripePromotionCodeParams, describeCoupon, planStripeImport } from '../src/utils/coupon-rules';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const NOW = new Date('2026-10-13T12:00:00Z');
const founder = { name: 'Founding member', code: 'founder30', discountType: 'percent', discountValue: '30', duration: 'repeating', durationInMonths: '12' };

console.log('\nCoupon rules');

check('the founding-member coupon is 30% off for 12 months, code upper-cased', () => {
    const v = validateCouponInput(founder, NOW);
    assert.ok(v.ok, !v.ok ? v.error : '');
    if (!v.ok) return;
    assert.strictEqual(v.value.code, 'FOUNDER30');
    assert.deepStrictEqual(stripeCouponParams(v.value), {
        name: 'Founding member', duration: 'repeating', duration_in_months: 12, percent_off: 30,
        metadata: { source: 'bms_admin_coupons' },
    });
    assert.strictEqual(describeCoupon(v.value), '30% off for 12 months');
});

check('the promotion code points at the coupon, in the API version we pin', () => {
    const v = validateCouponInput({ ...founder, maxRedemptions: '50', redeemBy: '2026-12-31T23:59:59Z' }, NOW);
    assert.ok(v.ok);
    if (!v.ok) return;
    const p = stripePromotionCodeParams(v.value, 'co_123');
    assert.deepStrictEqual(p.promotion, { type: 'coupon', coupon: 'co_123' });
    assert.strictEqual(p.code, 'FOUNDER30');
    assert.strictEqual(p.max_redemptions, 50);
    assert.strictEqual(p.expires_at, Math.floor(Date.parse('2026-12-31T23:59:59Z') / 1000));
});

check('a £ coupon is in pence with a currency, never with percent_off', () => {
    const v = validateCouponInput({ name: 'Tenner', code: 'TENOFF', discountType: 'amount', discountValue: '10', duration: 'once' }, NOW);
    assert.ok(v.ok);
    if (!v.ok) return;
    const c = stripeCouponParams(v.value) as Record<string, unknown>;
    assert.strictEqual(c.amount_off, 1000);
    assert.strictEqual(c.currency, 'gbp');
    assert.ok(!('percent_off' in c) && !('duration_in_months' in c));
    assert.strictEqual(describeCoupon(v.value), '£10 off the first payment');
});

check('every shape Stripe would reject is refused here first, with a plain message', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
        [{ ...founder, name: '' }, /name/i],
        [{ ...founder, code: 'a b' }, /code/i],
        [{ ...founder, code: 'X' }, /code/i],
        [{ ...founder, discountValue: '0' }, /greater than zero/i],
        [{ ...founder, discountValue: '120' }, /more than 100%/i],
        [{ ...founder, duration: 'weekly' }, /how long/i],
        [{ ...founder, durationInMonths: '' }, /months/i],
        [{ ...founder, durationInMonths: '1.5' }, /months/i],
        [{ ...founder, maxRedemptions: '0' }, /usage limit/i],
        [{ ...founder, redeemBy: '2026-01-01' }, /future/i],
    ];
    for (const [body, msg] of bad) {
        const v = validateCouponInput(body, NOW);
        assert.ok(!v.ok, `accepted ${JSON.stringify(body)}`);
        if (!v.ok) assert.match(v.error, msg);
    }
});

console.log('\nThe function');

const fn = read('netlify/functions/admin-coupons.ts');

check('only billing admins and above, never during impersonation or in sandbox', () => {
    assert.ok(/requirePermission\(admin\?\.role, 'manage_coupons'\)/.test(fn));
    assert.ok(/manage_coupons:\s+2,/.test(read('src/utils/rbac.ts')), 'manage_coupons must be billing_admin (rank 2)');
    assert.ok(/tok\.scope === 'impersonate'/.test(fn));
    assert.ok(/=== 'sandbox'/.test(fn));
});

check('it uses the same Stripe account as checkout, not the admin sandbox toggle', () => {
    assert.ok(/new Stripe\(stripeKey/.test(fn) && /process\.env\.STRIPE_SECRET_KEY/.test(fn));
    assert.ok(!/getStripe\(/.test(fn), 'getStripe() follows the admin toggle — a coupon made there would be missing at checkout');
});

check('a failed promotion-code create rolls the coupon back', () => {
    const create = fn.slice(fn.indexOf("if (event.httpMethod === 'POST')"), fn.indexOf('const [row] = await db.insert(billingCoupons)'));
    assert.ok(/promotionCodes\.create[\s\S]*catch[\s\S]*stripe\.coupons\.del\(coupon\.id\)/.test(create), 'an orphan coupon would be left in Stripe');
});

check('edit changes only what Stripe allows; delete deactivates before deleting and keeps the row', () => {
    const patch = fn.slice(fn.indexOf("if (event.httpMethod === 'PATCH')"), fn.indexOf("if (event.httpMethod === 'DELETE')"));
    assert.ok(!/percentOff|amountOffPence|duration/.test(patch.replace(/\/\/[^\n]*/g, '')), 'PATCH must not touch the discount or duration — Stripe forbids it');
    const del = fn.slice(fn.indexOf("if (event.httpMethod === 'DELETE')"));
    assert.ok(del.indexOf('promotionCodes.update') < del.indexOf('coupons.del'), 'deactivate the code first');
    assert.ok(/deletedAt: new Date\(\)/.test(del) && !/db\.delete\(/.test(del), 'the row is kept, stamped deleted');
});

check('every change is in the admin audit log', () => {
    for (const a of ['coupon_create', 'coupon_update', 'coupon_delete']) {
        assert.ok(fn.includes(`action: '${a}'`), `${a} is not logged`);
        assert.ok(read('src/utils/admin-audit.ts').includes(`'${a}'`), `${a} is not an AdminAction`);
    }
});

console.log('\nThe screen, checkout and the promo preview');

const admin = read('admin.html');

check('Coupons sits under Revenue and loads its view', () => {
    assert.ok(/\{ view: 'coupons',[^}]*perm: 'manage_coupons' \}/.test(admin));
    assert.ok(/if \(view === 'coupons'\)\s+loadCoupons\(\);/.test(admin));
    assert.ok(admin.includes('id="view-coupons"'));
});

check('the modal is not inside an .admin-view (it would be clipped)', () => {
    const modalAt = admin.indexOf('id="coupon-modal"');
    const lastViewOpen = admin.lastIndexOf('class="admin-view', modalAt);
    const mainClose = admin.indexOf('</main>');
    assert.ok(modalAt > mainClose || lastViewOpen === -1, 'coupon-modal must live outside <main>, like ai-credits-modal');
});

check('checkout previews the discount off the real plan price', () => {
    const vp = read('netlify/functions/validate-promo.ts');
    assert.ok(!/MONTHLY_PRICES_GBP/.test(vp), 'the hardcoded price copy is back');
    assert.ok(/masterPlans\.monthlyPriceGbp/.test(vp));
});

check('a ?promo= link pre-applies the code at checkout', () => {
    const co = read('checkout.html');
    assert.ok(/params\.get\('promo'\)/.test(co) && /await window\._applyPromo\(\)/.test(co));
});

check('the migration matches the schema', () => {
    const sqlText = read('db/z-billing-coupons.sql');
    const schema = read('db/schema.ts');
    for (const col of ['stripe_coupon_id', 'stripe_promotion_code_id', 'livemode', 'deleted_at', 'duration_in_months', 'amount_off_pence', 'percent_off']) {
        assert.ok(sqlText.includes(col) && schema.includes(`"${col}"`), `${col} missing from the SQL or schema.ts`);
    }
});

console.log('\nImporting what already exists in Stripe');

const sc = (over: Record<string, unknown> = {}) => ({ id: 'co_A', name: 'Launch', percent_off: 20, amount_off: null, currency: null, duration: 'once' as const, duration_in_months: null, max_redemptions: null, redeem_by: null, valid: true, times_redeemed: 3, ...over });
const sp = (over: Record<string, unknown> = {}) => ({ id: 'promo_1', code: 'launch20', active: true, couponId: 'co_A', max_redemptions: null, expires_at: null, created: 1_790_000_000, times_redeemed: 3, ...over });

check('one row per promotion code not already on the screen; a re-run imports nothing', () => {
    const first = planStripeImport([sc()], [sp()], new Set());
    assert.strictEqual(first.rows.length, 1);
    assert.strictEqual(first.rows[0].code, 'LAUNCH20');
    assert.strictEqual(first.rows[0].percentOff, '20');
    assert.strictEqual(first.rows[0].stripePromotionCodeId, 'promo_1');
    assert.strictEqual(planStripeImport([sc()], [sp()], new Set(['promo_1'])).rows.length, 0);
});

check('an inactive code or an invalid coupon imports as switched off, never as active', () => {
    assert.strictEqual(planStripeImport([sc()], [sp({ active: false })], new Set()).rows[0].isActive, false);
    assert.strictEqual(planStripeImport([sc({ valid: false })], [sp()], new Set()).rows[0].isActive, false);
});

check('a coupon with no promotion code is reported, not imported', () => {
    const r = planStripeImport([sc(), sc({ id: 'co_B', name: 'Manual only' })], [sp()], new Set());
    assert.strictEqual(r.rows.length, 1);
    assert.deepStrictEqual(r.noCode.map((c) => c.id), ['co_B']);
});

check('the Stripe check and import run server-side, with the live key never leaving Netlify', () => {
    const fn = read('netlify/functions/admin-coupons.ts');
    assert.ok(/queryStringParameters\?\.view === 'stripe'/.test(fn));
    assert.ok(/body\.action === 'import'/.test(fn));
    const imp = fn.slice(fn.indexOf("body.action === 'import'"), fn.indexOf('// ── Create'));
    assert.ok(!/stripe\.(coupons|promotionCodes)\.(create|update|del)/.test(imp), 'import must change nothing in Stripe');
    assert.ok(/Check Stripe/.test(read('admin.html')) && /couponImportStripe/.test(read('admin.html')));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
