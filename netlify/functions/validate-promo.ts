// netlify/functions/validate-promo.ts
// US-GAP-8.2.1 SC2: Validate a Stripe promotion code and return discount details
//
// POST { code: string, tier: string, billingCycle: 'monthly' | 'annual' }
// → { valid: true,  promotionCodeId, discountType, discountValue, discountedAmountGbp, discountDisplay }
// → { valid: false, error: string }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret    = process.env.JWT_SECRET!;
const stripeSecret = process.env.STRIPE_SECRET_KEY!;

if (!stripeSecret) throw new Error('CRITICAL: STRIPE_SECRET_KEY is missing.');

const stripe    = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });
const isTestMode = stripeSecret.startsWith('sk_test_');

// Monthly prices by tier (must stay in sync with create-subscription.ts)
const MONTHLY_PRICES_GBP: Record<string, number> = isTestMode
    ? { buster: 49, saver: 99, employee: 149 }
    : { buster: 49, saver: 99, employee: 149 };

const ANNUAL_DISCOUNT = 0.80;

function parseSession(event: any): number | null {
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const userId = parseSession(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let body: { code?: string; tier?: string; billingCycle?: string };
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { code, tier = 'saver', billingCycle = 'monthly' } = body;
    if (!code?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ valid: false, error: 'Please enter a promo code.' }) };
    }

    // Look up the promotion code via Stripe API
    let promoCodes: Stripe.PromotionCode[];
    try {
        const result = await stripe.promotionCodes.list({
            code: code.trim().toUpperCase(),
            active: true,
            limit: 1,
            expand: ['data.promotion.coupon'],
        });
        promoCodes = result.data;
    } catch (err: any) {
        console.error('[validate-promo] Stripe error:', err.message);
        return { statusCode: 502, body: JSON.stringify({ valid: false, error: 'Could not validate code. Please try again.' }) };
    }

    if (!promoCodes.length) {
        return {
            statusCode: 200,
            body: JSON.stringify({ valid: false, error: 'This code is not valid or has expired.' }),
        };
    }

    const promoCode = promoCodes[0];
    const coupon    = promoCode.promotion.coupon;

    // Check coupon is still redeemable (coupon is expanded above; guard the
    // string/null cases the Stripe types allow)
    if (!coupon || typeof coupon === 'string' || !coupon.valid) {
        return {
            statusCode: 200,
            body: JSON.stringify({ valid: false, error: 'This code is not valid or has expired.' }),
        };
    }

    // Calculate the discounted amount
    const tierKey   = (tier || 'saver').toLowerCase();
    const baseGbp   = (MONTHLY_PRICES_GBP[tierKey] || 99);
    const chargeGbp = billingCycle === 'annual'
        ? parseFloat((baseGbp * 12 * ANNUAL_DISCOUNT).toFixed(2))
        : baseGbp;

    let discountedAmountGbp: number;
    let discountDisplay: string;
    let discountAmountDisplay: string;

    if (coupon.percent_off) {
        const discountFraction = coupon.percent_off / 100;
        discountedAmountGbp    = parseFloat((chargeGbp * (1 - discountFraction)).toFixed(2));
        discountDisplay        = `-${coupon.percent_off}%`;
        discountAmountDisplay  = `-£${(chargeGbp - discountedAmountGbp).toFixed(2).replace(/\.00$/, '')}`;
    } else if (coupon.amount_off) {
        // amount_off is in pence (smallest currency unit)
        const discountGbp      = coupon.amount_off / 100;
        discountedAmountGbp    = Math.max(0, parseFloat((chargeGbp - discountGbp).toFixed(2)));
        discountDisplay        = `-£${discountGbp.toFixed(2).replace(/\.00$/, '')}`;
        discountAmountDisplay  = discountDisplay;
    } else {
        return {
            statusCode: 200,
            body: JSON.stringify({ valid: false, error: 'This code is not valid or has expired.' }),
        };
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            valid:               true,
            promotionCodeId:     promoCode.id,
            couponId:            coupon.id,
            discountDisplay,
            discountAmountDisplay,
            originalAmountGbp:   chargeGbp,
            discountedAmountGbp,
            codeName:            promoCode.code,
        }),
    };
});
