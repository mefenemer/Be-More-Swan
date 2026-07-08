// netlify/functions/legal-consent.ts
// US-AUD-4.3.1 SC5: AI disclaimer acknowledgement tracking.
//
//  GET  → { aiDisclaimerAccepted: bool, acceptedAt: string | null }
//  POST { action: 'acknowledge_ai_disclaimer' } → records acceptedAt in userProfiles.legalConsents

import { HandlerEvent } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, userProfiles } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event: HandlerEvent) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };

    const rawCookies = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookies.split(';').map(c => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
        }).filter(([k]) => k !== '')
    );
    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }

    const db = getDb();

    if (event.httpMethod === 'GET') {
        const [profile] = await db
            .select({ legalConsents: userProfiles.legalConsents })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);
        const consents = (profile?.legalConsents as Record<string, any>) || {};
        return {
            statusCode: 200,
            body: JSON.stringify({
                aiDisclaimerAccepted: !!consents.aiDisclaimerAcceptedAt,
                acceptedAt: consents.aiDisclaimerAcceptedAt || null,
                tosVersion: consents.tosVersion || null,
            }),
        };
    }

    if (event.httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { action } = body;
        if (action !== 'acknowledge_ai_disclaimer') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
        }
        const [profile] = await db
            .select({ legalConsents: userProfiles.legalConsents })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);
        const consents = (profile?.legalConsents as Record<string, any>) || {};
        const updated = {
            ...consents,
            aiDisclaimerAcceptedAt: new Date().toISOString(),
            tosVersion: '2026-06-10', // bump when ToS is updated to force re-acceptance
        };
        await db
            .update(userProfiles)
            .set({ legalConsents: updated, updatedAt: new Date() })
            .where(eq(userProfiles.userId, userId));
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
});
