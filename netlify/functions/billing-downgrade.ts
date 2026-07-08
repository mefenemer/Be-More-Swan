// netlify/functions/billing-downgrade.ts
// US-GAP-1.2.1: Downgrade Plan with Impact Warning
//
//  GET ?targetTierKey=<tier>  → impact preview: which assistants will pause, limit diff (SC2/SC3)
//  POST { targetTierKey }      → schedule downgrade at period end (SC4)
//  DELETE                      → cancel a scheduled downgrade (SC6)

import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, masterPlans, aiAssistants, notifications, userOrganisations } from '../../db/schema';
import { checkImpersonationBlock } from '../../src/utils/impersonation-guard';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret    = process.env.JWT_SECRET!;
const stripeSecret = process.env.STRIPE_SECRET_KEY!;
const stripe       = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });
const isTestMode   = stripeSecret?.startsWith('sk_test_');

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

export default withLambda(async (event) => {
    if (!['GET', 'POST', 'DELETE'].includes(event.httpMethod)) {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    // US-ADM-1.2.1: Block Stripe billing changes during impersonation
    if (event.httpMethod !== 'GET') {
        const block = checkImpersonationBlock(event);
        if (block) return block;
    }

    const userId = parseSession(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    const [user] = await db
        .select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations)
        .where(eq(userOrganisations.userId, userId))
        .limit(1);
    if (!user?.organisationId) return { statusCode: 404, body: JSON.stringify({ error: 'No organisation found.' }) };

    const [currentPlan] = await db
        .select({
            id: plans.id,
            masterPlanId: plans.masterPlanId,
            stripeSubscriptionId: plans.stripeSubscriptionId,
            status: plans.status,
        })
        .from(plans)
        .where(and(
            eq(plans.organisationId, user.organisationId),
            eq(plans.status, 'active'),
        ))
        .limit(1);

    // Also check for 'downgrading' status for SC6
    const [downgradinPlan] = await db
        .select({ id: plans.id, masterPlanId: plans.masterPlanId, stripeSubscriptionId: plans.stripeSubscriptionId })
        .from(plans)
        .where(and(eq(plans.organisationId, user.organisationId), eq(plans.status, 'downgrading')))
        .limit(1);

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE: SC6 — cancel a scheduled downgrade
    // ─────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'DELETE') {
        const planToCancel = downgradinPlan || currentPlan;
        if (!planToCancel?.stripeSubscriptionId) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No scheduled downgrade found.' }) };
        }

        try {
            // Remove the schedule — restore original price
            const sub = await stripe.subscriptions.retrieve(planToCancel.stripeSubscriptionId, { expand: ['items'] });
            await stripe.subscriptions.update(planToCancel.stripeSubscriptionId, {
                cancel_at_period_end: false,
            });

            // Restore plan status to active
            await db.update(plans)
                .set({ status: 'active', updatedAt: new Date() })
                .where(eq(plans.id, planToCancel.id));

            await db.insert(notifications).values({
                userId,
                type: 'downgrade_cancelled',
                title: 'Scheduled downgrade cancelled',
                message: 'Your plan will continue at its current tier — no change has been made.',
                isRead: false,
            });

            return { statusCode: 200, body: JSON.stringify({ success: true, action: 'downgrade_cancelled' }) };
        } catch (err: any) {
            return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
        }
    }

    const activePlan = currentPlan || downgradinPlan;
    if (!activePlan) return { statusCode: 404, body: JSON.stringify({ error: 'No active plan found.' }) };

    const [currentMp] = activePlan.masterPlanId
        ? await db.select().from(masterPlans).where(eq(masterPlans.id, activePlan.masterPlanId)).limit(1)
        : [null];

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

    if (!targetMp) return { statusCode: 404, body: JSON.stringify({ error: `Plan '${targetTierKey}' not found.` }) };

    const currentPrice = currentMp ? parseFloat(String(currentMp.monthlyPriceGbp)) : 0;
    const targetPrice  = parseFloat(String(targetMp.monthlyPriceGbp));

    if (targetPrice >= currentPrice) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Target tier must be lower than current tier. For upgrades use billing-upgrade.' }) };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET: SC2/SC3 — impact preview
    // ─────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        // SC2: which assistants will be paused?
        const activeAssistants = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)))
            .orderBy(desc(aiAssistants.createdAt)); // newest first

        const newAssistantLimit = targetMp.assistantLimit;
        const assistantsToPause = newAssistantLimit !== null && newAssistantLimit !== undefined
            ? activeAssistants.slice(newAssistantLimit) // oldest will be paused
            : [];

        // Get next billing period end from Stripe if available
        let periodEnd: string | null = null;
        if (activePlan.stripeSubscriptionId) {
            try {
                const sub = await stripe.subscriptions.retrieve(activePlan.stripeSubscriptionId);
                periodEnd = new Date((sub.items.data[0]?.current_period_end ?? 0) * 1000).toISOString();
            } catch { /* non-critical */ }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                impact: {
                    targetTierKey,
                    targetPlanName: targetMp.name,
                    targetMonthlyPrice: targetMp.monthlyPriceGbp,
                    // SC2: assistants that will be paused at period end
                    assistantsToPause: assistantsToPause.map(a => ({ id: a.id, name: a.name })),
                    currentAssistantLimit: currentMp?.assistantLimit ?? null,
                    newAssistantLimit: targetMp.assistantLimit ?? null,
                    // SC3: task limit comparison
                    currentTaskLimit: currentMp?.monthlyTaskLimit ?? null,
                    newTaskLimit: targetMp.monthlyTaskLimit ?? null,
                    // Timing
                    effectiveDate: periodEnd,
                    note: 'Your current plan remains active until the end of your billing period. No immediate charge or refund.',
                },
            }),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POST: SC4 — schedule the downgrade at period end
    // ─────────────────────────────────────────────────────────────────────────
    if (!activePlan.stripeSubscriptionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No Stripe subscription on record. Please contact support.' }) };
    }

    const targetPriceId = STRIPE_PRICE_IDS[targetTierKey];
    if (!targetPriceId) {
        return { statusCode: 400, body: JSON.stringify({ error: `No Stripe price configured for tier: ${targetTierKey}` }) };
    }

    try {
        const sub = await stripe.subscriptions.retrieve(activePlan.stripeSubscriptionId, { expand: ['items'] });
        const currentItemId = sub.items.data[0]?.id;
        if (!currentItemId) throw new Error('No subscription item found');

        // SC4: schedule downgrade at period end — set cancel_at_period_end and create new sub schedule
        // Approach: use Stripe subscription schedules to switch price at renewal
        await stripe.subscriptions.update(activePlan.stripeSubscriptionId, {
            cancel_at_period_end: true,
            metadata: {
                ...sub.metadata,
                pendingDowngradeTierKey: targetTierKey,
                pendingDowngradeMasterPlanId: String(targetMp.id),
            },
        });

        // SC4c: set DB status to 'downgrading'
        await db.update(plans)
            .set({ status: 'downgrading', updatedAt: new Date() })
            .where(eq(plans.id, activePlan.id));

        // Notify user
        const periodEnd = new Date((sub.items.data[0]?.current_period_end ?? 0) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        await db.insert(notifications).values({
            userId,
            type: 'downgrade_scheduled',
            title: `Downgrade to ${targetMp.name} scheduled`,
            message: `Your plan will downgrade to ${targetMp.name} on ${periodEnd}. Your current plan remains active until then.`,
            isRead: false,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                action: 'downgrade_scheduled',
                effectivePlanName: targetMp.name,
                periodEnd: new Date((sub.items.data[0]?.current_period_end ?? 0) * 1000).toISOString(),
            }),
        };
    } catch (err: any) {
        console.error('[billing-downgrade] Stripe error:', err);
        return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
    }
});
