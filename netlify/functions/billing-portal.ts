// billing-portal.ts
// POST → creates a Stripe Customer Portal session and returns { url }
// Used for "Change Card" — redirects to Stripe's hosted portal.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
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
    const portalBaseUrl = resolveBaseUrl(event.headers);
    if (!portalBaseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    const returnUrl = `${portalBaseUrl}/workspace.html#billing`;

    try {
        const db = getDb();
        const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

        // Resolve Stripe customer
        const [user] = await db.select({ email: users.email })
            .from(users).where(eq(users.id, userId));
        if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

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
            return { statusCode: 404, body: JSON.stringify({ error: 'No Stripe customer found for this account.' }) };
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: session.url }),
        };

    } catch (err: any) {
        console.error('[billing-portal]', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Failed to create portal session.' }) };
    }
});
