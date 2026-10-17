// tests/referral-offer.test.ts
// A referred friend gets their first month free, and the referrer earns a token only once that
// friend has actually paid.
//
// WHY THIS EXISTS (found 2026-10-17):
//   1. The plan picker applied a discount only if a Stripe coupon existed whose id was the
//      referrer's personal code. None did, so every referred friend paid full price while the
//      banner promised "20% off your first 3 months".
//   2. verify.ts sent new users to the plan gate without ?ref, so the code rarely reached
//      checkout anyway.
//   3. With a free first month, qualifying the referral on checkout.session.completed would hand
//      the referrer a token for a £0 invoice.
//
// Run:  npx tsx tests/referral-offer.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plans, userReferrals } from '../db/schema';
import {
    ANNUAL_ONE_MONTH_PERCENT_OFF, REFERRAL_COUPON_IDS, findReferralOffer, resolveReferralCouponId,
} from '../src/utils/referral-offer';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** select().from(table).where().limit() → the rows given for that table. */
function fakeDb(rows: Map<unknown, unknown[]>) {
    return {
        select: () => {
            let table: unknown;
            const q: any = {
                from: (t: unknown) => { table = t; return q; },
                where: () => q,
                limit: async () => rows.get(table) ?? [],
            };
            return q;
        },
    };
}

(async () => {
    console.log('\nWho gets the offer');

    await check('a pending referral with no plan ever → the offer, with the referrer\'s code', async () => {
        const db = fakeDb(new Map<unknown, unknown[]>([[userReferrals, [{ id: 7, referralCode: 'ABCD1234' }]], [plans, []]]));
        assert.deepStrictEqual(await findReferralOffer(db, 42), { referralId: 7, referralCode: 'ABCD1234' });
    });

    await check('no pending referral → no offer', async () => {
        const db = fakeDb(new Map<unknown, unknown[]>([[userReferrals, []], [plans, []]]));
        assert.strictEqual(await findReferralOffer(db, 42), null);
    });

    await check('someone who has held a plan before does not get a second free month', async () => {
        const db = fakeDb(new Map<unknown, unknown[]>([[userReferrals, [{ id: 7, referralCode: 'ABCD1234' }]], [plans, [{ id: 1 }]]]));
        assert.strictEqual(await findReferralOffer(db, 42), null);
    });

    console.log('\nThe coupons');

    await check('missing coupons are created once: 100% off once (monthly), one month of twelve once (annual)', async () => {
        const created: any[] = [];
        const stripe: any = {
            coupons: {
                retrieve: async () => { throw Object.assign(new Error('No such coupon'), { code: 'resource_missing' }); },
                create: async (p: any) => { created.push(p); return { id: p.id }; },
            },
        };
        assert.strictEqual(await resolveReferralCouponId(stripe, 'monthly'), REFERRAL_COUPON_IDS.monthly);
        assert.strictEqual(await resolveReferralCouponId(stripe, 'annual'), REFERRAL_COUPON_IDS.annual);
        assert.deepStrictEqual(created.map(c => [c.id, c.percent_off, c.duration]), [
            [REFERRAL_COUPON_IDS.monthly, 100, 'once'],
            [REFERRAL_COUPON_IDS.annual, 8.33, 'once'],
        ]);
        assert.strictEqual(ANNUAL_ONE_MONTH_PERCENT_OFF, 8.33);
    });

    await check('an existing coupon is reused, not recreated', async () => {
        let createCalls = 0;
        const stripe: any = {
            coupons: {
                retrieve: async (id: string) => ({ id, valid: true }),
                create: async () => { createCalls++; return { id: 'x' }; },
            },
        };
        assert.strictEqual(await resolveReferralCouponId(stripe, 'monthly'), REFERRAL_COUPON_IDS.monthly);
        assert.strictEqual(createCalls, 0);
    });

    await check('a Stripe outage is not mistaken for a missing coupon', async () => {
        const stripe: any = {
            coupons: {
                retrieve: async () => { throw Object.assign(new Error('timeout'), { code: 'api_connection_error' }); },
                create: async () => { throw new Error('must not create'); },
            },
        };
        await assert.rejects(resolveReferralCouponId(stripe, 'monthly'), /timeout/);
    });

    console.log('\nThe wiring');

    await check('checkout decides the offer server-side and never uses a browser-sent code as a coupon id', () => {
        const src = read('netlify/functions/create-plan-checkout-intent.ts');
        assert.ok(/findReferralOffer\(db, user\.id\)/.test(src));
        assert.ok(/coupon: await resolveReferralCouponId\(stripe, billingCycle\)/.test(src));
        assert.ok(!/coupons\.retrieve\(referralCode\)/.test(src), 'the old coupon-id-is-the-referral-code lookup is back');
    });

    await check('the webhook qualifies a referral only when money was taken', () => {
        const src = read('netlify/functions/stripe-webhook.ts');
        assert.ok(/if \(\(session\.amount_total \?\? 0\) > 0\) \{\s*try \{\s*await qualifyPendingReferral/.test(src),
            'checkout.session.completed must not qualify on a £0 session');
        assert.ok(/if \(invoice\.amount_paid > 0\) \{\s*try \{\s*await qualifyPendingReferral/.test(src),
            'invoice.paid must qualify the referral on the first paid invoice');
    });

    await check('verify.ts carries the referral code to the plan gate for its banner', () => {
        assert.ok(/workspace\.html\?action=select-plan\$\{refSuffix\}/.test(read('netlify/functions/verify.ts')));
    });

    console.log(`\n${passed} passed`);
})();
