// netlify/functions/create-plan-checkout-intent.ts
// P0 BUG FIX: Dedicated Stripe Checkout Session endpoint for the plan gate modal.
// Accepts only { planId, currency?, billingCycle? } — no assistant payload required. A referralCode
// in the body is ignored: the referral offer is decided server-side (src/utils/referral-offer.ts).
// Returns { url } for redirect to Stripe Checkout.
// AC3: No ai_assistants or payments rows created here; those happen post-webhook.

import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, masterPlans, planPrices } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';
import { checkImpersonationBlock } from '../../src/utils/impersonation';
import { annualAmountGbp, resolveAnnualPriceId, resolveMonthlyPriceId } from '../../src/utils/stripe-price';
import { findReferralOffer, resolveReferralCouponId } from '../../src/utils/referral-offer';

const stripeSecret = process.env.STRIPE_SECRET_KEY!;

const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

const SUPPORTED_CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD'];

export default withLambda(async (event) => {
    // US-ADM-1.2.1: never during an admin impersonation session (src/utils/impersonation.ts).
    const impersonationBlock = checkImpersonationBlock(event, 'plan_checkout');
    if (impersonationBlock) return impersonationBlock;

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db = getDb();
    // Auth + resolve the active organisation (verifies membership; never trusts the claim alone).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId: currentUserId, organisationId: orgId } = ctx;

    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) {
        console.error('[create-plan-checkout-intent] Could not resolve base URL (BASE_URL unset and no host header)');
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured: base URL unavailable' }) };
    }

    let planId: number; let requestedCurrency: string | undefined; let requestedCycle: string | undefined;
    try {
        const body = JSON.parse(event.body || '{}');
        ({ planId, currency: requestedCurrency, billingCycle: requestedCycle } = body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    if (!planId) return { statusCode: 400, body: JSON.stringify({ error: 'planId is required' }) };

    // Annual plans bill a single 12-month lump sum at a 20% discount; monthly bills each month.
    const billingCycle: 'monthly' | 'annual' = requestedCycle === 'annual' ? 'annual' : 'monthly';

    try {
    const currency = SUPPORTED_CURRENCIES.includes((requestedCurrency ?? '').toUpperCase())
        ? (requestedCurrency!).toUpperCase()
        : 'GBP';

    // Load user
    const [user] = await db.select({ id: users.id, email: users.email, role: users.role })
        .from(users).where(eq(users.id, currentUserId)).limit(1);
    if (!user || !user.email) return { statusCode: 403, body: JSON.stringify({ error: 'User not found' }) };

    // AC18: gate does not apply to admins
    if (user.role === 'admin' || user.role === 'super_admin') {
        return { statusCode: 403, body: JSON.stringify({ error: 'Plan gate does not apply to admin accounts' }) };
    }

    // Load master plan
    const [plan] = await db.select().from(masterPlans)
        .where(and(eq(masterPlans.id, planId), eq(masterPlans.isActive, true))).limit(1);
    if (!plan) return { statusCode: 400, body: JSON.stringify({ error: 'Plan not found or inactive' }) };

    // Resolve currency pricing
    const [planPrice] = await db.select().from(planPrices)
        .where(and(eq(planPrices.masterPlanId, plan.id), eq(planPrices.currency, currency), eq(planPrices.isActive, true)))
        .limit(1);

    const monthlyAmount = planPrice ? Number(planPrice.monthlyPriceMajorUnit) : Number(plan.monthlyPriceGbp);
    const priceCurrency = (planPrice ? currency : 'GBP').toLowerCase();
    // A GBP monthly plan with no configured price uses the SAME reusable Stripe price checkout.html
    // uses (found by lookup key, created once). It used to fall through to inline price_data below,
    // which mints a brand-new one-off Stripe Price on every checkout — on prod that was every
    // £29 and £349 purchase from the in-app plan picker (only £79 had a plan_prices row).
    const stripePriceId = planPrice?.stripePriceId
        ?? (billingCycle === 'monthly' && priceCurrency === 'gbp' ? await resolveMonthlyPriceId(stripe, plan) : null);

    // Build Stripe line item.
    // - Monthly: reuse a configured Stripe price if present, else a dynamic monthly price.
    // - Annual: always dynamic (the configured Stripe price is a MONTHLY price), billed once a
    //   year as 12 × monthly × 0.8.
    let lineItem: Stripe.Checkout.SessionCreateParams.LineItem;
    // (A stored plan_prices.stripe_price_id is a MONTHLY price, so it never applies here.)
    if (billingCycle === 'annual' && priceCurrency === 'gbp') {
        // The SAME reusable yearly Price checkout.html uses, on the plan's own product. This used to
        // be inline price_data, which minted a new product AND price on every annual checkout.
        lineItem = { price: await resolveAnnualPriceId(stripe, plan), quantity: 1 };
    } else if (billingCycle === 'annual') {
        // Another currency: no reusable price exists, so price it inline at the advertised sum.
        const annualAmount = annualAmountGbp(monthlyAmount);
        lineItem = {
            quantity: 1,
            price_data: {
                currency: priceCurrency,
                product_data: { name: `Be More Swan ${plan.name} (annual)` },
                unit_amount: Math.round(annualAmount * 100),
                recurring: { interval: 'year' },
            },
        };
    } else if (stripePriceId) {
        lineItem = { price: stripePriceId, quantity: 1 };
    } else {
        lineItem = {
            quantity: 1,
            price_data: {
                currency: priceCurrency,
                product_data: { name: `Be More Swan ${plan.name}` },
                unit_amount: Math.round(monthlyAmount * 100),
                recurring: { interval: 'month' },
            },
        };
    }

    // Referred friend → first month free. Decided from the user_referrals row written at signup,
    // never from a code the browser sends (see src/utils/referral-offer.ts).
    const referralOffer = await findReferralOffer(db, user.id);
    const referralCode = referralOffer?.referralCode;

    // Build Stripe Checkout Session
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: 'subscription',
        line_items: [lineItem],
        customer_email: user.email,
        success_url: `${baseUrl}/workspace.html?plan_activated=true`,
        cancel_url: `${baseUrl}/workspace.html?plan_cancelled=true`,
        metadata: {
            userId: String(user.id),
            organisationId: String(orgId),
            masterPlanId: String(plan.id),
            planName: plan.name,
            billingCycle,
            ...(referralCode ? { referralCode } : {}),
        },
        subscription_data: {
            metadata: {
                userId: String(user.id),
                masterPlanId: String(plan.id),
                billingCycle,
                ...(referralCode ? { referralCode } : {}),
            },
        },
    };

    // Referred friend → first month free (see the lookup above).
    let discountApplied = false;
    if (referralOffer) {
        sessionParams.discounts = [{ coupon: await resolveReferralCouponId(stripe, billingCycle) }];
        discountApplied = true;
    }

    // Let the customer enter a promo code on Stripe's hosted page (this is where 100%-off
    // codes are redeemed — a £0 invoice still fires checkout.session.completed and activates
    // the plan). Stripe forbids combining `allow_promotion_codes` with a fixed `discounts`
    // coupon, so only enable it when no referral coupon was pre-applied.
    if (!discountApplied) {
        sessionParams.allow_promotion_codes = true;
    }

    try {
        const session = await stripe.checkout.sessions.create(sessionParams);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: session.url }),
        };
    } catch (err: any) {
        console.error('[create-plan-checkout-intent] stripe', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create checkout session' }) };
    }
    } catch (err: any) {
        // Catch DB / unexpected errors so the function returns clean JSON instead of a 502.
        console.error('[create-plan-checkout-intent] unhandled', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error creating checkout session' }) };
    }
});
