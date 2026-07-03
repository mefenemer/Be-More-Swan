// netlify/functions/accept-tos.ts
// US-GOV-1.2.1: Record user acceptance of the current Terms of Service version.
//
// POST { version?: string } — records acceptance; defaults to CURRENT_TOS_VERSION.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { tosAcceptances, users } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { retryBlockedAssistants } from '../../src/utils/retry-provisioning';

export const CURRENT_TOS_VERSION = '2.0';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(token, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    let body: { version?: string } = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* use defaults */ }

    const version = body.version || CURRENT_TOS_VERSION;
    const ipAddress = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || event.headers['client-ip'] || null;
    const userAgent = event.headers['user-agent'] || null;

    const db = getDb();

    // Idempotent — ignore if already accepted this version
    const [existing] = await db.select({ id: tosAcceptances.id })
        .from(tosAcceptances)
        .where(and(eq(tosAcceptances.userId, userId), eq(tosAcceptances.version, version)))
        .limit(1);

    if (!existing) {
        await db.insert(tosAcceptances).values({ userId, version, ipAddress, userAgent });
    }

    // Re-trigger any assistants this user blocked on a ToS gate (best-effort; re-evaluates all gates).
    const baseUrl = resolveBaseUrl(event.headers);
    if (baseUrl) {
        await retryBlockedAssistants(db, { baseUrl, userId }).catch(() => {});
    }

    return { statusCode: 200, body: JSON.stringify({ accepted: true, version }) };
};
