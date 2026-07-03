import { config } from 'dotenv';
import * as path from 'path';
import Stripe from 'stripe';

config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { users, masterPlans } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error('CRITICAL: NETLIFY_DATABASE_URL is missing.');
const stripeSecret = process.env.STRIPE_SECRET_KEY;
if (!stripeSecret) throw new Error('CRITICAL: STRIPE_SECRET_KEY is missing.');

const pgClient = postgres(connectionString);
const db = drizzle({ client: pgClient });
const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

// Stripe price IDs keyed by tier — test and live environments
const isTestMode = stripeSecret.startsWith('sk_test_');
const STRIPE_PRICE_IDS: Record<string, string> = isTestMode
  ? {
      buster:   'price_1TgGNFE7lvVYjk1BAsnhUzBp',
      saver:    'price_1TgGP8E7lvVYjk1BRBeEZVd6',
      employee: 'price_1TgGPfE7lvVYjk1B1CQrS6pE',
    }
  : {
      buster:   'price_1Tg6f1CuS8qyNSsFxeUsfi4a',
      saver:    'price_1Tg6fQCuS8qyNSsF5DKmEqMu',
      employee: 'price_1Tg6fiCuS8qyNSsF787zwCwh',
    };

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    // 1. AUTH + resolve the active organisation (verifies membership; never trusts the claim alone).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId: currentUserId, organisationId: orgId } = ctx;

    const [user] = await db.select().from(users).where(eq(users.id, currentUserId)).limit(1);
    if (!user || user.status !== 'active') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Account not active.' }) };
    }

    const { tier, billingCycle: rawCycle, promotionCodeId } = JSON.parse(event.body || '{}');
    if (!tier) return { statusCode: 400, body: JSON.stringify({ error: 'Missing tier.' }) };

    const billingCycle: 'monthly' | 'annual' = rawCycle === 'annual' ? 'annual' : 'monthly';

    // Annual discount: 20% off (12 months × monthly price × 0.8)
    const ANNUAL_DISCOUNT = 0.80;

    // 2. LOOK UP MASTER PLAN
    const tierKey = tier.toLowerCase();
    const [masterPlan] = await db.select().from(masterPlans)
      .where(eq(masterPlans.tierKey, tierKey))
      .limit(1);
    if (!masterPlan) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan tier.' }) };

    const stripePriceId = STRIPE_PRICE_IDS[tierKey];
    if (!stripePriceId) {
      return { statusCode: 400, body: JSON.stringify({ error: `No Stripe price configured for tier: ${tierKey}` }) };
    }

    // Compute charge amount based on billing cycle
    const monthlyGbp    = Number(masterPlan.monthlyPriceGbp);
    const baseChargeGbp = billingCycle === 'annual'
        ? parseFloat((monthlyGbp * 12 * ANNUAL_DISCOUNT).toFixed(2))  // annual lump-sum
        : monthlyGbp;                                                   // monthly

    // SC3: Apply promotion code discount if provided (validated by validate-promo.ts)
    let chargeGbp        = baseChargeGbp;
    let discountAmountGbp: number | null = null;
    if (promotionCodeId) {
        try {
            const promoCode = await stripe.promotionCodes.retrieve(promotionCodeId, { expand: ['promotion.coupon'] });
            const coupon    = promoCode.promotion.coupon;
            if (coupon && typeof coupon !== 'string' && coupon.valid) {
                if (coupon.percent_off) {
                    discountAmountGbp = parseFloat((baseChargeGbp * coupon.percent_off / 100).toFixed(2));
                } else if (coupon.amount_off) {
                    discountAmountGbp = coupon.amount_off / 100;
                }
                if (discountAmountGbp !== null) {
                    chargeGbp = Math.max(0, parseFloat((baseChargeGbp - discountAmountGbp).toFixed(2)));
                }
            }
        } catch (promoErr: any) {
            console.warn('[create-subscription] Could not retrieve promo code — ignoring:', promoErr.message);
        }
    }

    const billingCycleLabel = billingCycle === 'annual'
        ? `Annual subscription (${Math.round((1 - ANNUAL_DISCOUNT) * 100)}% off)`
        : 'Monthly subscription';

    // 3. CREATE STRIPE CUSTOMER
    const customer = await stripe.customers.create({
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      metadata: { auraUserId: user.id.toString() },
    });

    // 4. CREATE THE SUBSCRIPTION — single source of truth for the charge.
    // ── Single-subscription pattern ─────────────────────────────────────────────
    // We create ONE subscription in `default_incomplete` state and hand its first
    // invoice's PaymentIntent to the browser to confirm. Confirming that PI both
    // takes the first payment AND activates the subscription, so the customer is
    // charged exactly once.
    //
    // Previously this endpoint created a standalone PaymentIntent and then BOTH the
    // webhook (payment_intent.succeeded) and confirm-payment.ts each called
    // subscriptions.create — every subscription with a saved card immediately
    // invoices, so the first period was charged two or three times. Creating the
    // subscription up front (and having the webhook/confirm-payment reuse it rather
    // than create new ones) eliminates that double-charge.
    let subscriptionItem: Stripe.SubscriptionCreateParams.Item;
    if (billingCycle === 'annual') {
      // Annual plans bill a 12-month lump sum (already discounted in baseChargeGbp) once a year.
      // dahlia API requires price_data.product (an ID); create the product explicitly.
      const annualProduct = await stripe.products.create({ name: masterPlan.name });
      subscriptionItem = {
        price_data: {
          currency: 'gbp',
          product: annualProduct.id,
          unit_amount: Math.round(baseChargeGbp * 100),
          recurring: { interval: 'year' },
        },
      };
    } else {
      subscriptionItem = { price: stripePriceId };
    }

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [subscriptionItem],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      proration_behavior: 'none',
      // dahlia: the client secret for confirming the incomplete subscription comes
      // from the latest invoice's confirmation_secret.
      expand: ['latest_invoice.confirmation_secret'],
      // SC3: apply a validated promotion code as a real Stripe discount on the invoice
      ...(promotionCodeId ? { discounts: [{ promotion_code: promotionCodeId }] } : {}),
      metadata: {
        userId:         user.id.toString(),
        organisationId: orgId.toString(),
        tier:           tierKey,
        masterPlanId:   masterPlan.id.toString(),
        billingCycle,
      },
    });

    const latestInvoice = subscription.latest_invoice as Stripe.Invoice;
    const clientSecret = latestInvoice?.confirmation_secret?.client_secret ?? null;
    if (!clientSecret) {
      throw new Error('Stripe did not return a client secret for the subscription invoice.');
    }

    // Stamp our metadata onto the invoice's PaymentIntent so the existing
    // payment_intent.succeeded webhook handler can create the plan/payment/invoice
    // records exactly as before — and so it (and confirm-payment.ts) reuse THIS
    // subscription instead of creating another. The PaymentIntent id is the prefix
    // of its client secret (pi_xxx_secret_yyy).
    const paymentIntentId = clientSecret.split('_secret_')[0];
    try {
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: {
          userId:               user.id.toString(),
          organisationId:       orgId.toString(),
          tier:                 tierKey,
          masterPlanId:         masterPlan.id.toString(),
          stripePriceId,
          stripeCustomerId:     customer.id,
          billingCycle,
          stripeSubscriptionId: subscription.id,
        },
      });
    } catch (metaErr: any) {
      console.error('[create-subscription] Failed to stamp PaymentIntent metadata:', metaErr?.message);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        data: {
          clientSecret,
          publishableKey:      process.env.STRIPE_PUBLISHABLE_KEY,
          planName:            masterPlan.name,
          amountGbp:           chargeGbp.toString(),
          originalAmountGbp:   baseChargeGbp.toString(),
          discountAmountGbp:   discountAmountGbp !== null ? discountAmountGbp.toString() : null,
          tier:                tierKey,
          billingCycle,
          billingCycleLabel,
        },
      }),
    };
  } catch (error: any) {
    console.error('create-subscription error:', error);
    const detail = error?.message || String(error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to initialise checkout.', detail }) };
  }
};
