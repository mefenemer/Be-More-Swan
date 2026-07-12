// netlify/functions/create-plan-checkout-intent.ts
// P0 BUG FIX: Dedicated Stripe Checkout Session endpoint for the plan gate modal.
// Accepts only { planId, referralCode?, currency? } — no assistant payload required.
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

const stripeSecret = process.env.STRIPE_SECRET_KEY!;

const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

const SUPPORTED_CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD'];

export default withLambda(async (event) => {
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

    let planId: number; let referralCode: string | undefined; let requestedCurrency: string | undefined; let requestedCycle: string | undefined;
    try {
        const body = JSON.parse(event.body || '{}');
        ({ planId, referralCode, currency: requestedCurrency, billingCycle: requestedCycle } = body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    if (!planId) return { statusCode: 400, body: JSON.stringify({ error: 'planId is required' }) };

    // Annual plans bill a single 12-month lump sum at a 20% discount; monthly bills each month.
    const billingCycle: 'monthly' | 'annual' = requestedCycle === 'annual' ? 'annual' : 'monthly';
    const ANNUAL_DISCOUNT = 0.80;

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
    const stripePriceId = planPrice?.stripePriceId ?? null;

    // Build Stripe line item.
    // - Monthly: reuse a configured Stripe price if present, else a dynamic monthly price.
    // - Annual: always dynamic (the configured Stripe price is a MONTHLY price), billed once a
    //   year as 12 × monthly × 0.8.
    let lineItem: Stripe.Checkout.SessionCreateParams.LineItem;
    if (billingCycle === 'annual') {
        // Match the advertised annual total (pricing.html): round the discounted monthly to a
        // whole unit, then ×12 — e.g. £349 → round(279.2)=£279 → £3,348/yr.
        const annualAmount = Math.round(monthlyAmount * ANNUAL_DISCOUNT) * 12;
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

    // Apply referral discount coupon if present and a matching Stripe coupon exists.
    let discountApplied = false;
    if (referralCode) {
        try {
            await stripe.coupons.retrieve(referralCode);
            sessionParams.discounts = [{ coupon: referralCode }];
            discountApplied = true;
        } catch {
            // No matching coupon — proceed without discount
        }
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
