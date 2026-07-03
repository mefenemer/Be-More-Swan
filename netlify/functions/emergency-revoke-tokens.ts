// netlify/functions/emergency-revoke-tokens.ts
// US-GDPR-3.2.1 SC3: Emergency revocation of OAuth/vault secrets for affected users.
// POST /.netlify/functions/emergency-revoke-tokens
//   Body: { incidentId, affectedUserIds: number[] }
//   Auth: super_admin only
//
// Calls deleteSecretsByPrefix() for each user, notifies them by email,
// marks the incident as 'contained', logs to admin_audit_log.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, securityIncidents, adminAuditLog } from '../../db/schema';
import { deleteSecretsByPrefix } from '../../src/utils/vault';
import { sendEmail } from '../../src/utils/email';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
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

    const { incidentId, affectedUserIds } = body;
    if (!incidentId || !Array.isArray(affectedUserIds) || affectedUserIds.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'incidentId and affectedUserIds[] are required.' }) };
    }

    const [incident] = await db.select().from(securityIncidents)
        .where(eq(securityIncidents.id, incidentId)).limit(1);
    if (!incident) return { statusCode: 404, body: JSON.stringify({ error: 'Incident not found.' }) };

    // Revoke all vault secrets for each affected user
    let totalRevoked = 0;
    const partialFailures: string[] = [];

    for (const userId of affectedUserIds) {
        try {
            // buildRefKey format: 'aura/user-{userId}/{service}-{type}'
            // Prefix 'aura/user-{userId}/' covers all services for this user.
            const prefix = `aura/user-${userId}/`;
            const revoked = await deleteSecretsByPrefix(db, prefix);
            totalRevoked += revoked;
        } catch (err: any) {
            partialFailures.push(`userId=${userId}: ${err?.message ?? 'unknown'}`);
        }
    }

    // Email all affected users
    const affectedUsers = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .where(inArray(users.id, affectedUserIds));

    for (const user of affectedUsers) {
        sendEmail({
            to: user.email,
            subject: 'Security Notice: Your connected app credentials have been revoked',
            html: `<p>Hi ${user.firstName || 'there'},</p>
                   <p>We have detected a security incident that may have affected your connected app credentials (e.g. Gmail, Slack, or other integrations).</p>
                   <p>As a precautionary measure, we have <strong>revoked all your connected app tokens</strong>. Your account and data remain secure.</p>
                   <p>To continue using your integrations, please reconnect your apps from your workspace settings.</p>
                   <p>We sincerely apologise for any inconvenience. If you have questions, please contact <a href="mailto:privacy@bemoreswan.com">privacy@bemoreswan.com</a>.</p>
                   <p>The Be More Swan Security Team</p>`,
        }).catch(() => {});
    }

    // Mark incident as contained
    await db.update(securityIncidents)
        .set({ status: 'contained', containedAt: new Date(), updatedAt: new Date() })
        .where(eq(securityIncidents.id, incidentId));

    // Audit log
    await db.insert(adminAuditLog).values({
        adminId,
        action: 'emergency_token_revocation',
        targetType: 'security_incident',
        targetId: String(incidentId),
        metadata: {
            affectedUserIds,
            totalRevoked,
            ...(partialFailures.length > 0 ? { partialFailures } : {}),
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
            totalRevoked,
            usersNotified: affectedUsers.length,
            ...(partialFailures.length > 0 ? { partialFailures } : {}),
        }),
    };
};
