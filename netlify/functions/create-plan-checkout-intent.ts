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

const stripeSecret = process.env.STRIPE_SECRET_KEY!;

const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

const SUPPORTED_CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD'];

export const handler: Handler = async (event) => {
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

    let planId: number; let referralCode: string | undefined; let requestedCurrency: string | undefined;
    try {
        const body = JSON.parse(event.body || '{}');
        ({ planId, referralCode, currency: requestedCurrency } = body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    if (!planId) return { statusCode: 400, body: JSON.stringify({ error: 'planId is required' }) };

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

    const priceAmount  = planPrice ? Number(planPrice.monthlyPriceMajorUnit) : Number(plan.monthlyPriceGbp);
    const priceCurrency = (planPrice ? currency : 'GBP').toLowerCase();
    const stripePriceId = planPrice?.stripePriceId ?? null;

    // Build Stripe line item
    const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = stripePriceId
        ? { price: stripePriceId, quantity: 1 }
        : {
            quantity: 1,
            price_data: {
                currency: priceCurrency,
                product_data: { name: `Be More Swan ${plan.name}` },
                unit_amount: Math.round(priceAmount * 100),
                recurring: { interval: 'month' },
            },
        };

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
            ...(referralCode ? { referralCode } : {}),
        },
        subscription_data: {
            metadata: {
                userId: String(user.id),
                masterPlanId: String(plan.id),
                ...(referralCode ? { referralCode } : {}),
            },
        },
    };

    // Apply referral discount coupon if present and a matching Stripe coupon exists
    if (referralCode) {
        try {
            await stripe.coupons.retrieve(referralCode);
            sessionParams.discounts = [{ coupon: referralCode }];
        } catch {
            // No matching coupon — proceed without discount
        }
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
};
