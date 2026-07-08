// netlify/functions/cancellation-survey.ts
// US-GAP-4.1.1: Exit Survey in Cancellation Flow
//
//  POST { reason, freeText? }            → SC2: store cancellation reason
//  POST { action: 'pause' }              → SC4: pause subscription (cancel_at_period_end) instead of cancel

import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, cancellationReasons, notifications } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret    = process.env.JWT_SECRET!;
const stripe       = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });

const VALID_REASONS = new Set([
    'too_expensive',
    'not_using',
    'missing_feature',
    'competitor',
    'technical',
    'business_closed',
    'other',
]);

function parseSession(event: any): number | null {
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try {
        return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch { return null; }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const userId = parseSession(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db   = getDb();
    const body = JSON.parse(event.body || '{}');

    // ── SC4: Pause action ─────────────────────────────────────────────────────
    if (body.action === 'pause') {
        const [currentPlan] = await db
            .select({ id: plans.id, stripeSubscriptionId: plans.stripeSubscriptionId, status: plans.status })
            .from(plans)
            .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
            .limit(1);

        if (!currentPlan?.stripeSubscriptionId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No active Stripe subscription found.' }) };
        }

        try {
            const sub = await stripe.subscriptions.retrieve(currentPlan.stripeSubscriptionId);

            // SC4a: set cancel_at_period_end=true (subscription stays active until period end, then cancels)
            await stripe.subscriptions.update(currentPlan.stripeSubscriptionId, {
                cancel_at_period_end: true,
                metadata: { ...sub.metadata, pausedByUser: 'true' },
            });

            // SC4b: DB flag — mark as paused_by_user (treated like 'cancelling' but user-initiated pause)
            await db.update(plans)
                .set({ status: 'cancelling', updatedAt: new Date() })
                .where(eq(plans.id, currentPlan.id));

            const periodEnd = new Date((sub.items.data[0]?.current_period_end ?? 0) * 1000).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'long', year: 'numeric',
            });

            // SC4c: in-app success notification
            await db.insert(notifications).values({
                userId,
                type: 'subscription_paused',
                title: 'Account paused — access continues until ' + periodEnd,
                message: `Your subscription will not renew. You'll have full access until ${periodEnd} — come back any time and your setup will be exactly as you left it.`,
                isRead: false,
            });

            // SC4d: no further cancellation emails — return success so the UI shows the confirmation
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    action: 'paused',
                    accessUntil: new Date((sub.items.data[0]?.current_period_end ?? 0) * 1000).toISOString(),
                    periodEndFormatted: periodEnd,
                }),
            };
        } catch (err: any) {
            return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
        }
    }

    // ── SC2: Store cancellation reason ────────────────────────────────────────
    const { reason, freeText } = body;
    if (!reason) {
        return { statusCode: 400, body: JSON.stringify({ error: 'reason is required.' }) };
    }
    if (!VALID_REASONS.has(reason)) {
        return { statusCode: 400, body: JSON.stringify({ error: `Invalid reason. Must be one of: ${[...VALID_REASONS].join(', ')}` }) };
    }

    await db.insert(cancellationReasons).values({
        userId,
        reason,
        freeText: freeText || null,
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
});
