// netlify/functions/billing-upgrade.ts
// US-GAP-1.1.1: Upgrade Plan Mid-Cycle
//
//  GET  ?preview=1&targetTierKey=<tier>  → proration preview (SC2)
//  POST { targetTierKey: string }         → execute upgrade (SC3)
//  GET  (no params)                       → available higher tiers list (SC1)

import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { eq, and, gt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, masterPlans, notifications, processedWebhookEvents, userOrganisations } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { checkImpersonationBlock } from '../../src/utils/impersonation';
import { resolveActionNotifications, PLAN_UPGRADED_TYPES } from '../../src/utils/notification-actions';

const jwtSecret      = process.env.JWT_SECRET!;
const stripeSecret   = process.env.STRIPE_SECRET_KEY!;
const stripe         = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });
const isTestMode     = stripeSecret?.startsWith('sk_test_');
const BASE_URL       = process.env.BASE_URL || '';

// Stripe monthly price IDs per tier key
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

function parseSession(event: any): number | null {
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number };
        return decoded.userId;
    } catch { return null; }
}

export const handler: Handler = async (event) => {
    if (!['GET', 'POST'].includes(event.httpMethod)) {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const userId = parseSession(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // Get user's active plan
    const [user] = await db.select({ organisationId: userOrganisations.organisationId }).from(userOrganisations).where(eq(userOrganisations.userId, userId)).limit(1);
    if (!user?.organisationId) return { statusCode: 404, body: JSON.stringify({ error: 'No organisation found.' }) };

    const [currentPlan] = await db
        .select({
            id: plans.id,
            masterPlanId: plans.masterPlanId,
            stripeCustomerId: plans.stripeCustomerId,
            stripeSubscriptionId: plans.stripeSubscriptionId,
            status: plans.status,
        })
        .from(plans)
        .where(and(eq(plans.organisationId, user.organisationId), eq(plans.status, 'active')))
        .limit(1);

    if (!currentPlan) return { statusCode: 404, body: JSON.stringify({ error: 'No active plan found.' }) };

    // Get current masterPlan for price comparison
    const [currentMp] = currentPlan.masterPlanId
        ? await db.select().from(masterPlans).where(eq(masterPlans.id, currentPlan.masterPlanId)).limit(1)
        : [null];

    // ─────────────────────────────────────────────────────────────────────────
    // GET (no params): SC1 — return available higher tiers
    // ─────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && !event.queryStringParameters?.preview) {
        const currentPrice = currentMp ? parseFloat(String(currentMp.monthlyPriceGbp)) : 0;

        const allPlans = await db
            .select({
                id: masterPlans.id,
                tierKey: masterPlans.tierKey,
                name: masterPlans.name,
                monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                assistantLimit: masterPlans.assistantLimit,
                monthlyTaskLimit: masterPlans.monthlyTaskLimit,
            })
            .from(masterPlans)
            .where(eq(masterPlans.isActive, true));

        const higherTiers = allPlans.filter(p => parseFloat(String(p.monthlyPriceGbp)) > currentPrice);
        const lowerTiers  = allPlans.filter(p => parseFloat(String(p.monthlyPriceGbp)) < currentPrice);

        return {
            statusCode: 200,
            body: JSON.stringify({
                currentPlan: currentMp ? {
                    tierKey: currentMp.tierKey,
                    name: currentMp.name,
                    monthlyPriceGbp: currentMp.monthlyPriceGbp,
                } : null,
                higherTiers: higherTiers.sort((a, b) =>
                    parseFloat(String(a.monthlyPriceGbp)) - parseFloat(String(b.monthlyPriceGbp))
                ),
                lowerTiers: lowerTiers.sort((a, b) =>
                    parseFloat(String(b.monthlyPriceGbp)) - parseFloat(String(a.monthlyPriceGbp))
                ),
                // SC6: on highest tier = no higher tiers available
                isOnHighestTier: higherTiers.length === 0,
            }),
        };
    }

    const targetTierKey = (
        event.queryStringParameters?.targetTierKey ||
        JSON.parse(event.body || '{}').targetTierKey ||
        ''
    ).toLowerCase();

    if (!targetTierKey) return { statusCode: 400, body: JSON.stringify({ error: 'targetTierKey is required.' }) };

    const [targetMp] = await db
        .select()
        .from(masterPlans)
        .where(and(eq(masterPlans.tierKey, targetTierKey), eq(masterPlans.isActive, true)))
        .limit(1);

    if (!targetMp) return { statusCode: 404, body: JSON.stringify({ error: `Plan tier '${targetTierKey}' not found.` }) };

    const currentPrice = currentMp ? parseFloat(String(currentMp.monthlyPriceGbp)) : 0;
    const targetPrice  = parseFloat(String(targetMp.monthlyPriceGbp));

    if (targetPrice <= currentPrice) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Target tier must be higher than current tier. For downgrades use billing-downgrade.' }) };
    }

    const targetPriceId = STRIPE_PRICE_IDS[targetTierKey];
    if (!targetPriceId) {
        return { statusCode: 400, body: JSON.stringify({ error: `No Stripe price configured for tier: ${targetTierKey}` }) };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET ?preview=1: SC2 — proration preview
    // ─────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && event.queryStringParameters?.preview) {
        if (!currentPlan.stripeSubscriptionId || !currentPlan.stripeCustomerId) {
            // No Stripe subscription on record (legacy plan) — show estimated diff only
            const diff = (targetPrice - currentPrice).toFixed(2);
            return {
                statusCode: 200,
                body: JSON.stringify({
                    preview: {
                        targetTierKey,
                        targetPlanName: targetMp.name,
                        targetMonthlyPrice: targetMp.monthlyPriceGbp,
                        proratedAmountGbp: diff,
                        proratedNote: 'Estimated — exact amount calculated at charge time',
                        newMonthlyAmount: targetMp.monthlyPriceGbp,
                        features: {
                            assistantLimit: targetMp.assistantLimit,
                            monthlyTaskLimit: targetMp.monthlyTaskLimit,
                        },
                    },
                }),
            };
        }

        try {
            const sub = await stripe.subscriptions.retrieve(currentPlan.stripeSubscriptionId, {
                expand: ['items'],
            });
            const currentItemId = sub.items.data[0]?.id;
            if (!currentItemId) throw new Error('No subscription item found');

            // Preview the proration invoice
            const upcoming = await stripe.invoices.createPreview({
                customer: currentPlan.stripeCustomerId,
                subscription: currentPlan.stripeSubscriptionId,
                subscription_details: {
                    items: [{ id: currentItemId, price: targetPriceId }],
                    proration_behavior: 'create_prorations',
                },
            });

            const proratedAmount = ((upcoming.amount_due || 0) / 100).toFixed(2);

            return {
                statusCode: 200,
                body: JSON.stringify({
                    preview: {
                        targetTierKey,
                        targetPlanName: targetMp.name,
                        targetMonthlyPrice: targetMp.monthlyPriceGbp,
                        proratedAmountGbp: proratedAmount,
                        proratedNote: `Due today (prorated for remainder of billing period)`,
                        newMonthlyAmount: targetMp.monthlyPriceGbp,
                        features: {
                            assistantLimit: targetMp.assistantLimit,
                            monthlyTaskLimit: targetMp.monthlyTaskLimit,
                        },
                    },
                }),
            };
        } catch (err: any) {
            return { statusCode: 502, body: JSON.stringify({ error: `Stripe preview failed: ${err.message}` }) };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST: SC3 — execute the upgrade via Stripe
    // ─────────────────────────────────────────────────────────────────────────
    const impersonationBlock = checkImpersonationBlock(event.headers.cookie, 'billing_upgrade');
    if (impersonationBlock) return impersonationBlock;

    if (!currentPlan.stripeSubscriptionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No Stripe subscription on record. Please contact support.' }) };
    }

    try {
        const sub = await stripe.subscriptions.retrieve(currentPlan.stripeSubscriptionId, { expand: ['items'] });
        const currentItemId = sub.items.data[0]?.id;
        if (!currentItemId) throw new Error('No subscription item found');

        // SC3: upgrade with proration — expand latest_invoice so prorated amount and URL are available
        const updatedSub = await stripe.subscriptions.update(currentPlan.stripeSubscriptionId, {
            items: [{ id: currentItemId, price: targetPriceId }],
            proration_behavior: 'create_prorations',
            metadata: {
                ...sub.metadata,
                tier: targetTierKey,
                masterPlanId: String(targetMp.id),
            },
            expand: ['latest_invoice'],
        });

        // SC3b: update DB plan record immediately
        await db.update(plans)
            .set({
                masterPlanId: targetMp.id,
                planName: targetMp.name,
                status: 'active',
                updatedAt: new Date(),
            })
            .where(eq(plans.id, currentPlan.id));

        // SC4a: in-app notification
        await db.insert(notifications).values({
            userId,
            type: 'plan_upgraded',
            title: `Plan upgraded to ${targetMp.name}`,
            message: `Your plan has been upgraded to ${targetMp.name}. Your new limits are active immediately.`,
            isRead: false,
        });

        // The upgrade resolves the trial / capacity / downgrade prompts that nudged it.
        await resolveActionNotifications(db, userId, PLAN_UPGRADED_TYPES);

        // SC4b: confirmation email (US-GAP-1.1.2 SC1/SC2/SC3)
        // Idempotency: keyed on upgrade-email:{subscriptionId}:{newPriceId} to prevent double-sends on retries
        const upgradeEmailKey = `upgrade-email:${currentPlan.stripeSubscriptionId}:${targetPriceId}`;
        const [emailAlreadySent] = await db
            .select({ id: processedWebhookEvents.id })
            .from(processedWebhookEvents)
            .where(eq(processedWebhookEvents.stripeEventId, upgradeEmailKey))
            .limit(1);

        if (!emailAlreadySent) {
            await db.insert(processedWebhookEvents)
                .values({ stripeEventId: upgradeEmailKey, eventType: 'upgrade_confirmation_email_sent' })
                .onConflictDoNothing();

            const [userRecord] = await db.select({ email: users.email, firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1);
            if (userRecord) {
                const latestInvoice = updatedSub.latest_invoice;
                const invoiceUrl = typeof latestInvoice === 'string' ? null : (latestInvoice as any)?.hosted_invoice_url || null;
                const proratedAmount = typeof latestInvoice === 'string' ? null : (((latestInvoice as any)?.amount_due || 0) / 100).toFixed(2);

                await sendEmail({
                    to: userRecord.email,
                    subject: `You've upgraded to ${targetMp.name} — welcome to your new plan`,
                    html: `<p>Hi ${userRecord.firstName || 'there'},</p>
                           <p>Your plan has been upgraded to <strong>${targetMp.name}</strong>.</p>
                           ${proratedAmount ? `<p>A prorated charge of <strong>£${proratedAmount}</strong> has been applied for the remainder of this billing period.</p>` : ''}
                           <p>Going forward, your monthly renewal will be <strong>£${targetMp.monthlyPriceGbp}/month</strong>.</p>
                           ${invoiceUrl ? `<p><a href="${invoiceUrl}">View your invoice →</a></p>` : ''}
                           <p><a href="${BASE_URL}/billing.html">View your billing page →</a></p>
                           <p>The Be More Swan Team</p>`,
                }).catch(() => { /* non-critical */ });
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                newPlan: {
                    tierKey: targetTierKey,
                    name: targetMp.name,
                    monthlyPriceGbp: targetMp.monthlyPriceGbp,
                    assistantLimit: targetMp.assistantLimit,
                    monthlyTaskLimit: targetMp.monthlyTaskLimit,
                },
            }),
        };
    } catch (err: any) {
        // SC5: charge failed — do NOT update plan in DB
        console.error('[billing-upgrade] Stripe error:', err);
        return {
            statusCode: 402,
            body: JSON.stringify({
                error: 'Unable to process upgrade — please check your payment details.',
                stripeError: err.message,
            }),
        };
    }
};
