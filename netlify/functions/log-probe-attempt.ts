// netlify/functions/log-probe-attempt.ts
// US-LEGAL-2.3: Prompt & Workflow Trade Secret Protections
//
// Called by the client when it detects a potential system-prompt extraction attempt:
// either the user asked the AI to reveal its instructions, or the AI response
// contained phrases indicating system-prompt disclosure.
//
// Logs the attempt to prompt_probe_attempts. After 3+ attempts in 24h by the same
// user, raises an admin notification flagging the workspace for review.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, gte, count, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { promptProbeAttempts, users, notifications } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const PROBE_RATE_THRESHOLD = 3;

export default withLambda(async (event) => {
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

    let body: { assistantId?: number; queryContent?: string; responseFragment?: string };
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const db = getDb();

    await db.insert(promptProbeAttempts).values({
        userId,
        assistantId: body.assistantId ?? null,
        queryContent: body.queryContent ? body.queryContent.slice(0, 1000) : null,
        responseFragment: body.responseFragment ? body.responseFragment.slice(0, 500) : null,
    });

    // Check probe count in the last 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ total }] = await db
        .select({ total: count() })
        .from(promptProbeAttempts)
        .where(and(
            eq(promptProbeAttempts.userId, userId),
            gte(promptProbeAttempts.detectedAt, since),
        ));

    if (total >= PROBE_RATE_THRESHOLD) {
        // Fetch user info for the notification body
        const [user] = await db
            .select({ email: users.email, firstName: users.firstName })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        const displayName = user ? `${user.firstName || ''} (${user.email})`.trim() : `userId ${userId}`;

        // Notify all superadmins and platform_admins
        const admins = await db
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.role as any, ['super_admin', 'platform_admin']));

        if (admins.length > 0) {
            await db.insert(notifications).values(
                admins.map(a => ({
                    userId: a.id,
                    type: 'security',
                    title: `Prompt extraction probe flagged: ${displayName}`,
                    message: `User ${displayName} has triggered ${total} probe attempt(s) in the last 24 hours. Review account and consider rate-limiting or suspending access.`,
                    isRead: false,
                }))
            ).catch(() => {});
        }
    }

    return { statusCode: 200, body: JSON.stringify({ logged: true }) };
});
