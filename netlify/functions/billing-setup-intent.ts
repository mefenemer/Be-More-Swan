// billing-setup-intent.ts
// POST → creates a Stripe SetupIntent for the authenticated user's customer
// Returns { clientSecret, customerId } — consumed by Stripe.js on the frontend.
// The SetupIntent allows Stripe to securely collect and store card details
// without any raw card data passing through our servers.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
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

    try {
        const db     = getDb();
        const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

        const [user] = await db.select({ id: users.id, email: users.email })
            .from(users).where(eq(users.id, userId));
        if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

        // Resolve or create Stripe customer
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

        // If no Stripe customer yet, create one so they can add a card
        if (!customerId) {
            const newCustomer = await stripe.customers.create({
                email: user.email || undefined,
                metadata: { auraUserId: String(userId) },
            });
            customerId = newCustomer.id;
        }

        // Create a SetupIntent — off_session so the saved card can be charged without user present
        const setupIntent = await stripe.setupIntents.create({
            customer: customerId,
            usage: 'off_session',
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientSecret: setupIntent.client_secret,
                customerId,
                publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
            }),
        };

    } catch (err: any) {
        console.error('[billing-setup-intent]', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Failed to create setup intent.' }) };
    }
});
