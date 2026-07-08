// netlify/functions/get-security-incidents.ts
// US-GDPR-3.2.1: Return security incidents with Article 33/34 breach timelines and countdown timers.
// GET /.netlify/functions/get-security-incidents[?id=N][?status=detected]
//   Auth: super_admin or platform_admin only

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, desc, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, securityIncidents } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

// Article 33/34 SLA deadlines (ms from discoveredAt)
const SLA_CONTROLLER_NOTIFY_MS  = 24 * 60 * 60 * 1000;  // 24h  — notify controller (data subject)
const SLA_REGULATOR_NOTIFY_MS   = 72 * 60 * 60 * 1000;  // 72h  — ICO/regulator notification

function buildTimeline(incident: any, now: Date) {
    const discovered = new Date(incident.discoveredAt).getTime();
    const controllerDeadline = new Date(discovered + SLA_CONTROLLER_NOTIFY_MS);
    const regulatorDeadline  = new Date(discovered + SLA_REGULATOR_NOTIFY_MS);

    const controllerMsRemaining = controllerDeadline.getTime() - now.getTime();
    const regulatorMsRemaining  = regulatorDeadline.getTime() - now.getTime();

    return {
        t0: {
            label: 'Incident Detected (T+0)',
            timestamp: incident.discoveredAt,
            completed: true,
        },
        controllerNotification: {
            label: 'Controller Notification Due (T+24h)',
            deadline: controllerDeadline.toISOString(),
            msRemaining: Math.max(controllerMsRemaining, 0),
            overdue: controllerMsRemaining < 0,
            completed: !!incident.controllerNotifiedAt,
            completedAt: incident.controllerNotifiedAt ?? null,
        },
        regulatorNotification: {
            label: 'ICO / Regulator Notification Due (T+72h) — Article 33',
            deadline: regulatorDeadline.toISOString(),
            msRemaining: Math.max(regulatorMsRemaining, 0),
            overdue: regulatorMsRemaining < 0,
            completed: !!incident.regulatorNotifiedAt,
            completedAt: incident.regulatorNotifiedAt ?? null,
        },
        dataSubjectNotification: {
            label: 'Data Subject Notification — Article 34 (if high risk)',
            required: ['high', 'critical'].includes(incident.severity),
            note: 'Required without undue delay if breach is likely to result in high risk to data subjects.',
        },
    };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    try {
        adminId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();
    const [admin] = await db.select({ role: users.role })
        .from(users).where(eq(users.id, adminId)).limit(1);

    if (!admin || !['super_admin', 'platform_admin'].includes(admin.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Requires super_admin or platform_admin.' }) };
    }

    const qs = event.queryStringParameters ?? {};
    const now = new Date();

    // Single incident by ID
    if (qs.id) {
        const id = parseInt(qs.id, 10);
        const [incident] = await db.select().from(securityIncidents)
            .where(eq(securityIncidents.id, id)).limit(1);
        if (!incident) return { statusCode: 404, body: JSON.stringify({ error: 'Incident not found.' }) };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ incident: { ...incident, timeline: buildTimeline(incident, now) } }),
        };
    }

    // List — optionally filter by status
    let query = db.select().from(securityIncidents).$dynamic();
    if (qs.status) {
        query = query.where(eq(securityIncidents.status, qs.status)) as any;
    }
    const incidents = await (query as any).orderBy(desc(securityIncidents.discoveredAt));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            incidents: incidents.map((i: any) => ({ ...i, timeline: buildTimeline(i, now) })),
        }),
    };
});
