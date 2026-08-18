// billing-cancel.ts
// POST { stripeSubscriptionId } → cancels at period end via Stripe
// Sets cancel_at_period_end: true (does NOT cancel immediately).

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { users, plans, leads } from '../../db/schema';
import { sendCancellationAlert } from '../../src/utils/founder-alerts';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret    = process.env.JWT_SECRET;
const stripeSecret = process.env.STRIPE_SECRET_KEY;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret)    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    if (!stripeSecret) return { statusCode: 503, body: JSON.stringify({ error: 'Stripe is not configured.' }) };

    // ── Auth ──────────────────────────────────────────────────────
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { stripeSubscriptionId } = body;

    if (!stripeSubscriptionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'stripeSubscriptionId is required.' }) };
    }

    try {
        const db = getDb();
        const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

        // Verify this subscription belongs to this user's Stripe customer
        const [user] = await db.select({ email: users.email })
            .from(users).where(eq(users.id, userId));
        if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);

        // Resolve the user's Stripe customer to verify ownership
        const byMeta = await stripe.customers.search({
            query: `metadata['auraUserId']:'${userId}'`,
            limit: 5,
        });
        let customerId: string | null = byMeta.data[0]?.id || null;
        if (!customerId && user.email) {
            const byEmail = await stripe.customers.list({ email: user.email, limit: 5 });
            customerId = byEmail.data[0]?.id || null;
        }

        if (!customerId || sub.customer !== customerId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Subscription does not belong to this account.' }) };
        }

        if (sub.status === 'canceled') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Subscription is already cancelled.' }) };
        }

        // Set cancel at period end in Stripe (graceful — access continues until renewal date)
        const updated = await stripe.subscriptions.update(stripeSubscriptionId, {
            cancel_at_period_end: true,
        });

        // Mirror the pending-cancellation status in our DB immediately.
        // The webhook (customer.subscription.deleted) will set it to 'cancelled' at period end.
        const [activePlan] = await db.update(plans)
            .set(withUpdatedAt({ status: 'cancelling' }))
            .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
            .returning({
                planName: plans.planName,
                organisationId: plans.organisationId,
                masterPlanId: plans.masterPlanId,
                stripeCustomerId: plans.stripeCustomerId,
            });

        // US-SALES-1.1 Part 3c: capture cancellation intent as a high-priority lead
        try {
            await db.insert(leads).values({
                email: user.email,
                opportunityReason: `Cancellation initiated — ${activePlan?.planName ?? 'unknown plan'}`,
                action: 'cancellation_intent',
                leadType: 'cancellation_intent',
                source: 'workspace_cancel',
                userId,
                organisationId: activePlan?.organisationId ?? null,
                priority: 'high',
            }).onConflictDoUpdate({
                target: [leads.email, leads.opportunityReason],
                set: { priority: 'high', updatedAt: new Date() },
            });
        } catch (leadErr) {
            console.error('[billing-cancel] lead capture failed (non-fatal):', leadErr);
        }

        // ── Founder alert — churn, while they are still a customer ───
        // Fired here rather than on customer.subscription.deleted: that webhook lands at
        // period end, weeks later, when nothing can be done. Never throws.
        const periodEndUnix = updated.items.data[0]?.current_period_end ?? null;
        await sendCancellationAlert({
            db,
            userId,
            organisationId:       activePlan?.organisationId ?? null,
            planName:             activePlan?.planName ?? null,
            masterPlanId:         activePlan?.masterPlanId ?? null,
            effectiveDate:        periodEndUnix ? new Date(periodEndUnix * 1000) : null,
            stripeCustomerId:     activePlan?.stripeCustomerId ?? customerId,
            stripeSubscriptionId,
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                cancelAtPeriodEnd: updated.cancel_at_period_end,
                currentPeriodEnd: updated.items.data[0]?.current_period_end ?? null,
            }),
        };

    } catch (err: any) {
        console.error('[billing-cancel]', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Failed to cancel subscription.' }) };
    }
});
