// billing-attach-payment.ts
// POST { paymentMethodId } → attaches a confirmed PaymentMethod to the customer,
// sets it as the default on all active subscriptions, and returns the
// safe card summary (brand, last4, expiry only — no PAN, no CVC).

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, payments } from '../../db/schema';
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
    const { paymentMethodId, postalCode } = body;
    if (!paymentMethodId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'paymentMethodId is required.' }) };
    }

    try {
        const db     = getDb();
        const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

        const [user] = await db.select({ id: users.id, email: users.email })
            .from(users).where(eq(users.id, userId));
        if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

        // Resolve Stripe customer
        let customerId: string | null = null;
        const byMeta = await stripe.customers.search({
            query: `metadata['auraUserId']:'${userId}'`,
            limit: 5,
        });
        if (byMeta.data.length > 0) {
            customerId = byMeta.data[0].id;
        } else if (user.email) {
            const byEmail = await stripe.customers.list({ email: user.email, limit: 5 });
            customerId = byEmail.data[0]?.id || null;
        }
        if (!customerId) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No Stripe customer found.' }) };
        }

        // Verify the PaymentMethod belongs to this customer (via SetupIntent — it was already confirmed)
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        if (pm.customer && pm.customer !== customerId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Payment method does not belong to this account.' }) };
        }

        // Attach to customer if not already attached
        if (!pm.customer) {
            await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
        }

        // Set as default payment method on the customer
        await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: paymentMethodId },
        });

        // Update default_payment_method on all active and trialing subscriptions
        const [activeSubs, trialingSubs] = await Promise.all([
            stripe.subscriptions.list({ customer: customerId, status: 'active',   limit: 20 }),
            stripe.subscriptions.list({ customer: customerId, status: 'trialing', limit: 20 }),
        ]);
        const allSubs = [...activeSubs.data, ...trialingSubs.data];
        await Promise.all(
            allSubs.map(sub =>
                stripe.subscriptions.update(sub.id, {
                    default_payment_method: paymentMethodId,
                })
            )
        );

        // Persist updated card details to all existing payment records for this user
        // so the payment history shows the card that was active at change time.
        const card = pm.card;
        if (card) {
            await db.update(payments)
                .set({
                    cardBrand:      card.brand      || null,
                    cardLast4:      card.last4      || null,
                    cardExpMonth:   card.exp_month  || null,
                    cardExpYear:    card.exp_year   || null,
                    cardPostalCode: postalCode      || null,
                    paymentMethod:  `${card.brand} ending ${card.last4}`,
                })
                .where(eq(payments.userId, userId));
        }

        // Return only the safe card summary — last4 is all that's stored/displayed
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                paymentMethod: card ? {
                    brand:    card.brand,
                    last4:    card.last4,
                    expMonth: card.exp_month,
                    expYear:  card.exp_year,
                } : null,
            }),
        };

    } catch (err: any) {
        console.error('[billing-attach-payment]', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Failed to save card.' }) };
    }
});
