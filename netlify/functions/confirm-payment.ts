import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, payments, masterPlans, notifications } from '../../db/schema';
import { resolveActionNotifications, PAYMENT_RESTORED_TYPES } from '../../src/utils/notification-actions';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });
const jwtSecret = process.env.JWT_SECRET!;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        // 1. Auth
        const cookieHeader = event.headers.cookie || '';
        const match = cookieHeader.match(/aura_session=([^;]+)/);
        const token = match ? match[1] : null;
        if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

        let userId: number;
        try {
            const decoded = jwt.verify(token, jwtSecret) as { userId: number };
            userId = decoded.userId;
        } catch {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) };
        }

        const { paymentIntentId } = JSON.parse(event.body || '{}');
        if (!paymentIntentId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentIntentId' }) };

        const db = getDb();

        // 2. Check if a plan already exists for this user (webhook may have already run)
        const [existingPlan] = await db
            .select({ id: plans.id })
            .from(plans)
            .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
            .limit(1);

        if (existingPlan) {
            return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyExists: true }) };
        }

        // 3. Retrieve the PaymentIntent from Stripe to verify it succeeded and get metadata
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (pi.status !== 'succeeded') {
            return { statusCode: 400, body: JSON.stringify({ error: `Payment not succeeded: ${pi.status}` }) };
        }

        const { organisationId, tier, masterPlanId, stripeCustomerId, stripeSubscriptionId } = pi.metadata || {};

        // Confirm the PaymentIntent belongs to this user
        if (parseInt(pi.metadata?.userId || '0') !== userId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'PaymentIntent does not belong to this user' }) };
        }

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };

        const orgIdInt = parseInt(organisationId);
        const masterPlanIdInt = masterPlanId ? parseInt(masterPlanId) : null;
        const amountGbp = pi.amount ? (pi.amount / 100).toFixed(2) : '0.00';

        // 4. Look up plan name
        let planName = tier ? `Be More Swan (${tier})` : 'Be More Swan Subscription';
        if (masterPlanIdInt) {
            const [mp] = await db.select().from(masterPlans).where(eq(masterPlans.id, masterPlanIdInt)).limit(1);
            if (mp) planName = mp.name;
        }

        // 5. Create plan record.
        // The Stripe subscription is created up-front by create-subscription.ts (default_incomplete
        // pattern) and this PaymentIntent is its first invoice payment — so we never create a
        // subscription here (that double-charged). We just persist the existing subscription's
        // references, read from the PI metadata. The webhook normally creates this record first;
        // this is the safety net for when the user lands before the webhook fires.
        let newPlan: typeof plans.$inferSelect;
        try {
            const [inserted] = await db.insert(plans).values({
                userId,
                organisationId: orgIdInt,
                masterPlanId: masterPlanIdInt,
                planName,
                planType: 'subscription',
                status: 'active',
                stripeCustomerId: stripeCustomerId || null,
                stripeSubscriptionId: stripeSubscriptionId || null,
            }).returning();
            newPlan = inserted;
        } catch (planErr: any) {
            // Webhook won the race and already created the active plan (unique constraint).
            if (planErr?.code === '23505' || planErr?.message?.includes('plans_one_active_per_org_unique')) {
                return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyExists: true }) };
            }
            throw planErr;
        }

        // 7. Create payment record
        await db.insert(payments).values({
            userId,
            organisationId: orgIdInt,
            planId: newPlan.id,
            masterPlanId: masterPlanIdInt,
            amount: amountGbp,
            currency: 'GBP',
            status: 'completed',
            externalPaymentId: pi.id,
            description: `${planName} — first payment`,
        });

        // 8. Notify user
        await db.insert(notifications).values({
            userId,
            type: 'billing',
            title: 'Payment Successful — Set Up Your Assistant',
            message: 'Your subscription is active. Click "Resume Setup" on your dashboard to build your Digital Assistant now.',
            isRead: false,
        });

        // Clear any lingering "fix your billing" action items now the subscription is active.
        await resolveActionNotifications(db, userId, PAYMENT_RESTORED_TYPES);

        return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyExists: false }) };

    } catch (err: any) {
        console.error('confirm-payment error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Server error' }) };
    }
};
