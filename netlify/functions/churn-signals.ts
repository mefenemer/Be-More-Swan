// netlify/functions/churn-signals.ts
// US-AUD-3.1.1 SC8: Admin churn risk dashboard data.
//
//  GET  → { signals: { signalType, userCount }[], total, generatedAt }
//
// Admin-only: requires isAdmin flag on the JWT or user record.

import { HandlerEvent } from '@netlify/functions';
import { eq, gte, count } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, userChurnSignals } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
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

    // Verify admin via DB role
    const db = getDb();
    const [adminUser] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    if (!adminUser || !['admin', 'super_admin'].includes(adminUser.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required.' }) };
    }

    // SC8: Count distinct users currently active per signal type
    // "Currently active" = signal detected and intervention NOT yet resolved / no recent re-signup
    // We count users with at least one signal in the last 30 days, grouped by signalType
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await db
        .select({
            signalType: userChurnSignals.signalType,
            userCount: count(userChurnSignals.userId),
        })
        .from(userChurnSignals)
        .where(gte(userChurnSignals.detectedAt, thirtyDaysAgo))
        .groupBy(userChurnSignals.signalType);

    const SIGNAL_LABELS: Record<string, string> = {
        no_tasks_7d: 'Zero tasks in 7 days',
        repeated_task_failure: 'Repeated task failures',
        integration_disconnected_48h: 'Integration disconnected 48h+',
        upgrade_intent_not_converted: 'Pricing viewed, no upgrade',
        early_support_ticket: 'Early support ticket (<30 days)',
    };

    const signals = rows.map(r => ({
        signalType: r.signalType,
        label: SIGNAL_LABELS[r.signalType] || r.signalType,
        userCount: Number(r.userCount),
    })).sort((a, b) => b.userCount - a.userCount);

    const total = signals.reduce((sum, s) => sum + s.userCount, 0);

    return {
        statusCode: 200,
        body: JSON.stringify({ signals, total, generatedAt: new Date().toISOString() }),
    };
});
