import { config } from 'dotenv';
import * as path from 'path';
import Stripe from 'stripe';

config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, sql } from 'drizzle-orm';
import {
  users,
  organisations,
  userProfiles,
  plans,
  aiAssistants,
  payments,
  masterPlans,
  masterAssistants,
  onboardingDrafts,
  planPrices,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { formatPlatformStrategyBrief } from '../../src/utils/platform-strategy-brief';

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error('CRITICAL: NETLIFY_DATABASE_URL is missing.');
const stripeSecret = process.env.STRIPE_SECRET_KEY;
if (!stripeSecret) throw new Error('CRITICAL: STRIPE_SECRET_KEY is missing.');

const pgClient = postgres(connectionString);
const db = drizzle({ client: pgClient });
const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

function sanitizeText(str: string): string {
  return str.replace(/[<>]/g, '');
}

function compileServerSideBrief(clientName: string, businessName: string, assistantName: string, inputs: any): string {
  if (!inputs) throw new Error('Transformation Failure: Missing inputs payload.');
  const missing = 'Not specified/Provided';
  const fmt = (arr: any[], fallback: string) => {
    if (!Array.isArray(arr) || arr.length === 0) return fallback;
    const valid = arr.filter(i => i && i.trim() !== '');
    return valid.length === 0 ? fallback : valid.map(i => `- ${i}`).join('\n');
  };
  return `
BE MORE SWAN ENGINEERING BRIEF: SOCIAL MEDIA MANAGER BLUEPRINT

CLIENT DETAILS
Name: ${clientName || missing}
Business: ${businessName || missing}
Assistant Name: ${assistantName || missing}

PROCESS BOTTLENECK
${inputs.problem?.trim() || missing}

SOURCING & TRIGGER
Trigger: ${inputs.triggerText?.trim() || missing}
Source: ${inputs.sourceText?.trim() || missing}

PUBLISHING DESTINATIONS
Platforms:
${fmt(inputs.platforms, missing)}

PLATFORM ALGORITHM STRATEGY
${formatPlatformStrategyBrief(inputs.platform_strategy) || missing}

GENERAL PREFERENCES & STRATEGY
${fmt(inputs.generalPreferences, missing)}

WORKFLOW LOGIC
${inputs.workflowText?.trim() || missing}

NON-NEGOTIABLE STRICT RULES
${fmt(inputs.strictRules, missing)}

APPROVAL PROTOCOL
All requests requiring your sign-off are managed exclusively through your Be More Swan Workspace. You will be notified by email immediately upon the creation of any new request.
`.trim();
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    // 1. AUTH + resolve the active organisation (verifies membership; never trusts the claim alone).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId: currentUserId, organisationId: orgId } = ctx;

    const [existingUser] = await db.select().from(users).where(eq(users.id, currentUserId)).limit(1);
    if (!existingUser || existingUser.status !== 'active') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Account pending verification.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { clientName, businessName, tier, assistantName, customAssistantName, rawInputs, onboardingContext, consents } = body;
    // US-I18N-2.1 SC3: user's selected currency (from frontend localStorage), fallback to GBP
    const requestedCurrency = (body.currency || 'GBP').toUpperCase();

    if (assistantName === 'Social Media Manager') {
      if (!onboardingContext?.target_audience || !onboardingContext?.content_pillars || !onboardingContext?.tone_of_voice || !onboardingContext?.primary_platforms?.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required Social Media Manager context fields.' }) };
      }
    }

    // 2. MASTER PLAN LOOKUP
    const [masterPlan] = await db.select().from(masterPlans).where(eq(masterPlans.tierKey, tier?.toLowerCase() || 'employee')).limit(1);
    if (!masterPlan) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid subscription tier selected.' }) };

    // US-I18N-2.1 SC3: resolve currency pricing — fall back to GBP if no plan_prices row for requested currency
    const SUPPORTED_CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD'];
    const currency = SUPPORTED_CURRENCIES.includes(requestedCurrency) ? requestedCurrency : 'GBP';
    const [planPrice] = await db.select().from(planPrices)
        .where(and(eq(planPrices.masterPlanId, masterPlan.id), eq(planPrices.currency, currency), eq(planPrices.isActive, true)))
        .limit(1);
    // SC4: fall back to GBP (existing behaviour) if no plan_prices row exists
    const priceAmount = planPrice
        ? Number(planPrice.monthlyPriceMajorUnit)
        : Number(masterPlan.monthlyPriceGbp);
    const priceCurrency = planPrice ? currency : 'GBP';
    const resolvedCurrencyFallback = !planPrice && currency !== 'GBP';

    const targetName = customAssistantName?.trim() || 'Digital Assistant';

    // 3. DEDUP CHECK — names are unique per organisation
    const [existingAssistant] = await db.select().from(aiAssistants).where(and(
      eq(aiAssistants.organisationId, orgId),
      sql`LOWER(${aiAssistants.name}) = LOWER(${targetName})`
    )).limit(1);

    if (existingAssistant) {
      if (existingAssistant.provisioningStatus === 'pending_payment') {
        await db.delete(aiAssistants).where(eq(aiAssistants.id, existingAssistant.id));
      } else {
        return { statusCode: 409, body: JSON.stringify({ error: 'An assistant with this name already exists in your organisation.' }) };
      }
    }

    // 4. DB TRANSACTION + STRIPE SUBSCRIPTION
    const result = await db.transaction(async (tx) => {
      await tx.update(userProfiles).set({ legalConsents: consents || {}, updatedAt: new Date() }).where(eq(userProfiles.userId, existingUser.id));

      if (businessName?.trim()) {
        await tx.update(organisations).set({ name: sanitizeText(businessName.trim()), updatedAt: new Date() }).where(eq(organisations.id, orgId));
      }

      const [newPlan] = await tx.insert(plans).values({
        organisationId: orgId,
        userId: existingUser.id,
        masterPlanId: masterPlan.id,
        planName: masterPlan.name,
        planType: 'subscription',
        // Billing currency is persisted on the payment + plan_prices rows; the
        // plans table has no currency column.
      }).returning();

      const [assistantRecord] = await tx.select().from(masterAssistants).where(eq(masterAssistants.name, assistantName || 'Social Media Manager')).limit(1);

      let secureSystemPrompt: string;
      try {
        secureSystemPrompt = compileServerSideBrief(clientName, sanitizeText(businessName || ''), targetName, rawInputs);
        if (!secureSystemPrompt) throw new Error('Empty brief.');
      } catch (e) {
        console.error('Brief compilation failed:', e);
        throw new Error('Failed to generate Assistant Blueprint due to missing or invalid data. Deployment aborted.');
      }

      const [newAssistant] = await tx.insert(aiAssistants).values({
        organisationId: orgId,
        userId: existingUser.id,
        masterAssistantId: assistantRecord?.id || null,
        name: targetName,
        model: 'gpt-4o',
        aiAssistantJobRole: assistantRecord?.name || 'General Assistant',
        systemPrompt: secureSystemPrompt,
        configuration: { type: assistantRecord ? assistantRecord.roleKey : 'custom', active: true, inputs: rawInputs || {} },
        onboardingContext: onboardingContext || {},
        isActive: false,
        provisioningStatus: 'pending_payment',
      }).returning();

      const [newPayment] = await tx.insert(payments).values({
        userId: existingUser.id,
        organisationId: orgId,
        planId: newPlan.id,
        amount: String(priceAmount),
        currency: priceCurrency,
        status: 'pending',
        description: `Be More Swan ${masterPlan.name} Setup`,
      }).returning();

      // Create Stripe Customer
      const customer = await stripe.customers.create({
        email: existingUser.email,
        name: clientName || existingUser.email,
        metadata: {
          userId: existingUser.id.toString(),
          auraAssistantId: newAssistant.id.toString(),
          auraPaymentId: newPayment.id.toString(),
        },
      });

      // Create Stripe Subscription (incomplete — waits for payment confirmation)
      // US-I18N-2.1 SC3: use Stripe Price ID from plan_prices if available, else price_data with resolved currency
      let subscriptionItem: Stripe.SubscriptionCreateParams.Item;
      if (planPrice?.stripePriceId) {
          subscriptionItem = { price: planPrice.stripePriceId };
      } else {
          // dahlia API requires price_data.product (an ID) rather than inline
          // product_data; create the product explicitly to carry name + metadata.
          const product = await stripe.products.create({
              name: `Be More Swan: ${targetName}`,
              metadata: { assistantType: assistantName || 'Digital Assistant' },
          });
          subscriptionItem = {
              price_data: {
                  currency: priceCurrency.toLowerCase(),
                  product: product.id,
                  unit_amount: Math.round(priceAmount * 100),
                  recurring: { interval: 'month' },
              },
          };
      }

      const subscriptionMeta: Record<string, string> = {
          userId: existingUser.id.toString(),
          assistantId: newAssistant.id.toString(),
          paymentId: newPayment.id.toString(),
      };
      // US-ONB-2.1.1: include referral code in metadata so webhook can correlate
      if (existingUser.referralCode) subscriptionMeta.referralCode = existingUser.referralCode;

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [subscriptionItem],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        // dahlia: invoices no longer expose payment_intent; the client secret for
        // confirming the incomplete subscription comes from confirmation_secret.
        expand: ['latest_invoice.confirmation_secret'],
        metadata: subscriptionMeta,
      });

      const latestInvoice = subscription.latest_invoice as Stripe.Invoice;
      const clientSecret = latestInvoice.confirmation_secret?.client_secret ?? null;

      return {
        clientSecret,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        planName: masterPlan.name,
        assistantName: targetName,
        amount: priceAmount,
        currency: priceCurrency,
        currencyFallback: resolvedCurrencyFallback, // true if requested currency was unavailable
        subscriptionId: subscription.id,
      };
    });

    return { statusCode: 200, body: JSON.stringify({ data: result }) };
  } catch (error: any) {
    console.error('create-checkout-intent error:', error);
    const errMsg = error.message?.includes('Blueprint') ? error.message : 'Failed to initialise checkout.';
    return { statusCode: 500, body: JSON.stringify({ error: errMsg }) };
  }
};
