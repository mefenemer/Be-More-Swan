// netlify/functions/report-security-incident.ts
// US-GDPR-3.2.1: Log a new security incident and raise P0 alerts for all superadmins.
// POST /.netlify/functions/report-security-incident
//   Body: { title, description, severity, dataTypesAffected, affectedUserCount, affectedUserIds?, notes? }
//   Auth: super_admin or platform_admin only

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, securityIncidents, notifications, adminAuditLog } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

const jwtSecret = process.env.JWT_SECRET;
const BASE_URL  = process.env.BASE_URL || 'https://bemoreswan.com';

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
    const [admin] = await db.select({ role: users.role, email: users.email })
        .from(users).where(eq(users.id, adminId)).limit(1);

    if (!admin || !['super_admin', 'platform_admin'].includes(admin.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Requires super_admin or platform_admin.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { title, description, severity, dataTypesAffected, affectedUserCount, affectedUserIds, notes } = body;
    if (!title?.trim() || !description?.trim() || !severity?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'title, description, and severity are required.' }) };
    }
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    if (!validSeverities.includes(severity)) {
        return { statusCode: 400, body: JSON.stringify({ error: `severity must be one of: ${validSeverities.join(', ')}` }) };
    }

    const [incident] = await db.insert(securityIncidents).values({
        title: title.trim(),
        description: description.trim(),
        severity,
        dataTypesAffected: dataTypesAffected ?? null,
        affectedUserCount: affectedUserCount ?? null,
        affectedUserIds: affectedUserIds ?? null,
        notes: notes?.trim() ?? null,
        reportedBy: adminId,
    }).returning();

    // Write to admin_audit_log (Article 33 audit trail)
    await db.insert(adminAuditLog).values({
        adminId,
        action: 'security_incident_detected',
        targetType: 'security_incident',
        targetId: String(incident.id),
        metadata: { severity, affectedUserCount, dataTypesAffected, incidentId: incident.id },
        ipAddress: event.headers['x-nf-client-connection-ip']
            || event.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || 'unknown',
        userAgent: event.headers['user-agent'] || null,
    }).catch(() => {});

    // Raise P0 in-app alert for all superadmins (high/critical incidents)
    const isHighRisk = ['high', 'critical'].includes(severity);
    if (isHighRisk) {
        const superAdmins = await db
            .select({ id: users.id, email: users.email, firstName: users.firstName })
            .from(users)
            .where(inArray(users.role as any, ['super_admin', 'platform_admin']));

        if (superAdmins.length > 0) {
            await db.insert(notifications).values(
                superAdmins.map(sa => ({
                    userId: sa.id,
                    type: 'security_incident_p0',
                    title: `⚠ P0 Security Incident: ${title}`,
                    message: `Severity: ${severity.toUpperCase()}. A security incident has been detected. ` +
                        `Visit the Admin Portal → Breach Response to review timelines and take action.`,
                    isRead: false,
                }))
            ).catch(() => {});

            // Also send email so superadmins are alerted even if not in-app
            for (const sa of superAdmins) {
                sendEmail({
                    to: sa.email,
                    subject: `[P0 ALERT] Security Incident Detected — ${title}`,
                    html: `<p>Hi ${sa.firstName || 'Admin'},</p>
                           <p>A <strong>${severity.toUpperCase()}</strong> security incident has been logged on Be More Swan:</p>
                           <p><strong>${title}</strong></p>
                           <p>${description}</p>
                           <p>
                             <a href="${BASE_URL}/admin.html#breach-response"
                                style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">
                               Open Breach Response Timeline →
                             </a>
                           </p>
                           <p><small>Incident ID: ${incident.id} | Discovered: ${incident.discoveredAt.toISOString()}</small></p>`,
                }).catch(() => {});
            }
        }
    }

    return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, incidentId: incident.id, severity, isHighRisk }),
    };
};
