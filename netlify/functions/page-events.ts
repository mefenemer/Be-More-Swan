// netlify/functions/page-events.ts
// US-AUD-3.1.1 SC5: Track significant page views for churn signal detection.
//
//  POST { pagePath: string, metadata?: object }
//   → { ok: true }

import { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { pageEvents } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
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

    const body = JSON.parse(event.body || '{}');
    const { pagePath, metadata } = body;

    if (!pagePath || typeof pagePath !== 'string') {
        return { statusCode: 400, body: JSON.stringify({ error: 'pagePath is required.' }) };
    }

    const db = getDb();
    await db.insert(pageEvents).values({ userId, pagePath, metadata: metadata || null });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
