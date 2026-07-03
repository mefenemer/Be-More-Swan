// netlify/functions/admin-impersonate.ts
// US-ADM-1.2.1: Admin Impersonation with Scoped Token & Audit Trail
//
// POST /.netlify/functions/admin-impersonate
//   Auth: aura_session (super_admin or platform_admin role required)
//   Body (start): { action: 'start', targetUserId: number, reason: string }
//   Body (end):   { action: 'end' }
//
// Start: issues an `aura_impersonation` cookie (15-min JWT, scope='impersonate').
//        Original aura_session is left intact and restored when the tab returns to admin portal.
//        Writes impersonate_start to admin_audit_log.
//
// End:   clears the aura_impersonation cookie and writes impersonate_end to admin_audit_log.
//
// Downstream endpoints guard dangerous operations by reading aura_impersonation and
// refusing Stripe charges, account deletion, and password changes when scope='impersonate'.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { resolveActiveOrg } from '../../src/utils/tenant';

const jwtSecret = process.env.JWT_SECRET;
const IMPERSONATION_TTL_SECONDS = 15 * 60; // 15 minutes

const ALLOWED_REASONS = ['support_investigation', 'billing_dispute', 'qa_testing', 'account_recovery'] as const;
type ImpersonationReason = typeof ALLOWED_REASONS[number];

export interface ImpersonationPayload {
    scope: 'impersonate';
    userId: number;                  // effective user for downstream auth
    realAdminId: number;             // original admin performing impersonation
    realAdminEmail: string;
    impersonatingUserId: number;
    targetUserEmail: string;
    targetUserName: string;
    sessionId: string;
    reason: ImpersonationReason;
    activeOrganisationId?: number;   // target user's active org, so impersonated requests resolve a tenant
    iat?: number;
    exp?: number;
}

export const handler: Handler = async (event) => {
    // Epic: Superadmin Environment Management — live-only admin action. Reject sandbox
    // requests so this can never run while the operator believes they are in sandbox
    // (prevents production bleed). See docs/SANDBOX-ENVIRONMENT.md.
    if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'This action is not available in Sandbox mode.' }) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
    }
    if (!jwtSecret) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    }

    // ── Authenticate requesting admin ─────────────────────────────────────────
    const sessionMatch = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!sessionMatch) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    try {
        adminId = (jwt.verify(sessionMatch[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();
    const [adminUser] = await db
        .select({ id: users.id, role: users.role, firstName: users.firstName, email: users.email })
        .from(users)
        .where(eq(users.id, adminId))
        .limit(1);

    if (!adminUser || !['super_admin', 'platform_admin'].includes(adminUser.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Impersonation requires platform_admin or super_admin role.' }) };
    }

    let body: { action?: string; targetUserId?: number; reason?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const ip = getAdminIp(event.headers);
    const ua = event.headers['user-agent'] || undefined;

    // ── END impersonation ─────────────────────────────────────────────────────
    if (body.action === 'end') {
        const impMatch = (event.headers.cookie || '').match(/aura_impersonation=([^;]+)/);
        let sessionId = 'unknown';
        let impersonatedUserId: number | undefined;

        if (impMatch) {
            try {
                const payload = jwt.verify(impMatch[1], jwtSecret) as ImpersonationPayload;
                sessionId = payload.sessionId;
                impersonatedUserId = payload.impersonatingUserId;
            } catch {
                // expired or tampered — still clear it
            }
        }

        void insertAdminAuditLog({
            adminId,
            action: 'impersonate_end',
            targetType: 'user',
            targetId: impersonatedUserId,
            ipAddress: ip,
            userAgent: ua,
            metadata: { sessionId },
        });

        return {
            statusCode: 200,
            headers: {
                'Set-Cookie': 'aura_impersonation=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ok: true }),
        };
    }

    // ── START impersonation ───────────────────────────────────────────────────
    if (body.action === 'start') {
        const { targetUserId, reason } = body;

        if (!targetUserId || typeof targetUserId !== 'number') {
            return { statusCode: 400, body: JSON.stringify({ error: 'targetUserId is required.' }) };
        }
        if (!reason || !ALLOWED_REASONS.includes(reason as ImpersonationReason)) {
            return { statusCode: 400, body: JSON.stringify({ error: `reason must be one of: ${ALLOWED_REASONS.join(', ')}` }) };
        }
        if (targetUserId === adminId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Cannot impersonate yourself.' }) };
        }

        const [targetUser] = await db
            .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, role: users.role })
            .from(users)
            .where(eq(users.id, targetUserId))
            .limit(1);

        if (!targetUser) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Target user not found.' }) };
        }

        // Prevent privilege escalation: never impersonate another admin
        if (['admin', 'super_admin', 'platform_admin'].includes(targetUser.role || '')) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Cannot impersonate admin users.' }) };
        }

        const sessionId = randomUUID();
        const targetUserName = [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ');
        const targetOrg = await resolveActiveOrg(db, targetUserId);

        const payload: ImpersonationPayload = {
            scope:               'impersonate',
            userId:              targetUserId,
            realAdminId:         adminId,
            realAdminEmail:      adminUser.email!,
            impersonatingUserId: targetUserId,
            targetUserEmail:     targetUser.email,
            targetUserName,
            sessionId,
            reason:              reason as ImpersonationReason,
            ...(targetOrg ? { activeOrganisationId: targetOrg.organisationId } : {}),
        };

        const token = jwt.sign(payload, jwtSecret, { expiresIn: `${IMPERSONATION_TTL_SECONDS}s` });

        void insertAdminAuditLog({
            adminId,
            action: 'impersonate_start',
            targetType: 'user',
            targetId: targetUserId,
            newState: { sessionId, reason, targetEmail: targetUser.email },
            reason,
            ipAddress: ip,
            userAgent: ua,
            metadata: { sessionId, ttlSeconds: IMPERSONATION_TTL_SECONDS },
        });

        return {
            statusCode: 200,
            headers: {
                'Set-Cookie': `aura_impersonation=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${IMPERSONATION_TTL_SECONDS}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ok: true,
                sessionId,
                targetEmail:      targetUser.email,
                targetName:       targetUserName,
                expiresInSeconds: IMPERSONATION_TTL_SECONDS,
            }),
        };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'action must be "start" or "end".' }) };
};
