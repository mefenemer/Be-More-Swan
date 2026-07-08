// netlify/functions/submit-regulator-notification.ts
// US-GDPR-3.2.1 SC4: Log ICO/regulator notification for an incident.
// POST /.netlify/functions/submit-regulator-notification
//   Body: { incidentId, natureOfBreach, categoriesOfData, approximateSubjectCount,
//           likelyConsequences, measuresTaken, notificationMethod? }
//   Auth: super_admin only
//
// Stores the completed ICO template fields and marks incident as 'notified_regulator'.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, securityIncidents, adminAuditLog } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
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

    if (!admin || admin.role !== 'super_admin') {
        return { statusCode: 403, body: JSON.stringify({ error: 'Requires super_admin.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const {
        incidentId,
        natureOfBreach,
        categoriesOfData,
        approximateSubjectCount,
        likelyConsequences,
        measuresTaken,
        notificationMethod,
    } = body;

    if (!incidentId || !natureOfBreach?.trim() || !categoriesOfData?.trim() ||
        !likelyConsequences?.trim() || !measuresTaken?.trim()) {
        return {
            statusCode: 400,
            body: JSON.stringify({
                error: 'incidentId, natureOfBreach, categoriesOfData, likelyConsequences, and measuresTaken are required.',
            }),
        };
    }

    const [incident] = await db.select().from(securityIncidents)
        .where(eq(securityIncidents.id, incidentId)).limit(1);
    if (!incident) return { statusCode: 404, body: JSON.stringify({ error: 'Incident not found.' }) };

    if (incident.regulatorNotifiedAt) {
        return {
            statusCode: 409,
            body: JSON.stringify({ error: 'Regulator notification already submitted for this incident.' }),
        };
    }

    const notificationBody = {
        natureOfBreach,
        categoriesOfData,
        approximateSubjectCount: approximateSubjectCount ?? null,
        likelyConsequences,
        measuresTaken,
        notificationMethod: notificationMethod ?? 'ico_online_portal',
        submittedAt: new Date().toISOString(),
        submittedBy: adminId,
    };

    const now = new Date();
    const hoursElapsed = (now.getTime() - new Date(incident.discoveredAt).getTime()) / (1000 * 60 * 60);

    await db.update(securityIncidents)
        .set({
            status: 'notified_regulator',
            regulatorNotifiedAt: now,
            regulatorNotificationBody: notificationBody,
            updatedAt: now,
        })
        .where(eq(securityIncidents.id, incidentId));

    await db.insert(adminAuditLog).values({
        adminId,
        action: 'regulator_notification_submitted',
        targetType: 'security_incident',
        targetId: String(incidentId),
        metadata: {
            incidentId,
            hoursElapsed: Math.round(hoursElapsed * 10) / 10,
            withinSla: hoursElapsed <= 72,
            notificationMethod: notificationBody.notificationMethod,
        },
        ipAddress: event.headers['x-nf-client-connection-ip']
            || event.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || 'unknown',
        userAgent: event.headers['user-agent'] || null,
    }).catch(() => {});

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            success: true,
            incidentId,
            hoursElapsed: Math.round(hoursElapsed * 10) / 10,
            withinSla: hoursElapsed <= 72,
            regulatorNotifiedAt: now.toISOString(),
        }),
    };
});
