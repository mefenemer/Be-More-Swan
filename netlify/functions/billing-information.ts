// billing-information.ts
// GET  → returns stored legal billing details for the authenticated user
// POST → upsert (insert or update) the user's billing details

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { billingInformation } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (!['GET', 'POST'].includes(event.httpMethod)) {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // ── Auth ──────────────────────────────────────────────────────
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    // ── GET ───────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        try {
            const [info] = await db.select({
                id:           billingInformation.id,
                fullName:     billingInformation.fullName,
                email:        billingInformation.email,
                addressLine1: billingInformation.addressLine1,
                addressLine2: billingInformation.addressLine2,
                city:         billingInformation.city,
                state:        billingInformation.state,
                country:      billingInformation.country,
                postalCode:   billingInformation.postalCode,
                vatNumber:    billingInformation.vatNumber,
                updatedAt:    billingInformation.updatedAt,
            })
            .from(billingInformation)
            .where(eq(billingInformation.userId, userId));

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ billingInfo: info || null }),
            };
        } catch (err: any) {
            console.error('[billing-information GET]', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load billing information.' }) };
        }
    }

    // ── POST ──────────────────────────────────────────────────────
    try {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { /* empty */ }

        const {
            fullName    = '',
            email       = '',
            addressLine1 = '',
            addressLine2 = '',
            city        = '',
            state       = '',
            country     = '',
            postalCode  = '',
            vatNumber   = '',
        } = body;

        if (!fullName || !fullName.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Legal name is required.' }) };
        }

        // Upsert — check if a record already exists
        const [existing] = await db.select({ id: billingInformation.id })
            .from(billingInformation)
            .where(eq(billingInformation.userId, userId));

        const values = {
            userId,
            fullName:     fullName.trim(),
            email:        email.trim() || null,
            addressLine1: addressLine1.trim() || null,
            addressLine2: addressLine2.trim() || null,
            city:         city.trim() || null,
            state:        state.trim() || null,
            country:      country.trim() || null,
            postalCode:   postalCode.trim() || null,
            vatNumber:    vatNumber.trim() || null,
            updatedAt:    new Date(),
        };

        let saved;
        if (existing) {
            [saved] = await db.update(billingInformation)
                .set(values)
                .where(eq(billingInformation.id, existing.id))
                .returning();
        } else {
            [saved] = await db.insert(billingInformation)
                .values(values)
                .returning();
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, billingInfo: saved }),
        };
    } catch (err: any) {
        console.error('[billing-information POST]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save billing information.' }) };
    }
});
