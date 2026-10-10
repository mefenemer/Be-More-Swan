// netlify/functions/admin-impersonate.ts
// US-ADM-1.2.1: Admin Impersonation with Scoped Token & Audit Trail
//
// GET  /.netlify/functions/admin-impersonate
//   Auth: aura_session. Reports whether THIS request is being served under impersonation, for the
//   workspace banner — aura_impersonation is HttpOnly, so the page cannot read it itself.
//   → { active: false } | { active: true, targetName, targetEmail, reason, sessionId, expiresAt }
//
// POST /.netlify/functions/admin-impersonate
//   Body (start): { action: 'start', targetUserId: number, reason: string }
//     Auth: aura_session, role must clear 'impersonate' (super_admin only).
//     Issues the `aura_impersonation` cookie (15-min JWT). The admin's aura_session is NOT touched:
//     it keeps them signed in, and the workspace reads the customer's data because requireTenant
//     honours the cookie (src/utils/impersonation.ts) — read-only, bound to this admin's session.
//     Writes impersonate_start to admin_audit_log.
//   Body (end):   { action: 'end' }
//     Auth: aura_session only — ending must never need the permission that started it, or a
//     demoted admin could not close their own session. Clears the cookie and writes impersonate_end.

import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { getSession } from '../../src/utils/session';
import { withLambda } from '@netlify/aws-lambda-compat';
import { requirePermission, isAdminRole } from '../../src/utils/rbac';
import {
    IMPERSONATION_COOKIE,
    IMPERSONATION_REASONS,
    IMPERSONATION_TTL_SECONDS,
    getImpersonationSession,
    resolveImpersonation,
    type ImpersonationPayload,
    type ImpersonationReason,
} from '../../src/utils/impersonation';

export type { ImpersonationPayload } from '../../src/utils/impersonation';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const CLEAR_COOKIE = `${IMPERSONATION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

const json = (statusCode: number, body: unknown, extra: Record<string, string> = {}) => ({
    statusCode,
    headers: { ...JSON_HEADERS, ...extra },
    body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
        return json(405, { error: 'Method not allowed.' });
    }

    // ── Authenticate the caller (the real admin — never the impersonated user) ─
    const session = getSession(event);
    if (!session) return json(401, { error: 'Not authenticated.' });
    const adminId = session.userId;
    const cookieHeader = event.headers.cookie ?? event.headers.Cookie;
    const db = getDb();

    // ── STATUS ────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        // Cheap exit for every ordinary customer page load: no cookie, no DB.
        if (!getImpersonationSession(cookieHeader)) return json(200, { active: false });
        const imp = await resolveImpersonation(db, cookieHeader, adminId);
        if (!imp) return json(200, { active: false });
        return json(200, {
            active:      true,
            sessionId:   imp.sessionId,
            targetName:  imp.targetUserName,
            targetEmail: imp.targetUserEmail,
            reason:      imp.reason,
            expiresAt:   imp.exp ? imp.exp * 1000 : null,
        });
    }

    let body: { action?: string; targetUserId?: number; reason?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const ip = getAdminIp(event.headers);
    const ua = event.headers['user-agent'] || undefined;

    // ── END impersonation ─────────────────────────────────────────────────────
    if (body.action === 'end') {
        const imp = getImpersonationSession(cookieHeader);
        // Only the admin who started a session may record its end; anyone may clear the cookie.
        if (imp && imp.realAdminId === adminId) {
            const startedAt = imp.iat ? imp.iat * 1000 : null;
            await insertAdminAuditLog({
                adminId,
                action: 'impersonate_end',
                targetType: 'user',
                targetId: imp.impersonatingUserId,
                newState: { sessionId: imp.sessionId },
                reason: 'impersonation_session_ended',
                ipAddress: ip,
                userAgent: ua,
                metadata: {
                    sessionId: imp.sessionId,
                    targetEmail: imp.targetUserEmail,
                    sessionDurationSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
                },
            });
        }
        return json(200, { ok: true, redirect: '/admin.html' }, { 'Set-Cookie': CLEAR_COOKIE });
    }

    // ── START impersonation ───────────────────────────────────────────────────
    if (body.action === 'start') {
        // Epic: Superadmin Environment Management — live-only admin action. Reject sandbox
        // requests so this can never run while the operator believes they are in sandbox
        // (prevents production bleed). See docs/SANDBOX-ENVIRONMENT.md.
        if (((event.headers['x-environment'] || event.headers['X-Environment'] || '') + '').trim().toLowerCase() === 'sandbox') {
            return json(400, { error: 'This action is not available in Sandbox mode.' });
        }

        const [adminUser] = await db
            .select({ id: users.id, role: users.role, email: users.email })
            .from(users)
            .where(eq(users.id, adminId))
            .limit(1);
        const denied = requirePermission(adminUser?.role, 'impersonate');
        if (denied) return { ...denied, headers: JSON_HEADERS };

        const { targetUserId, reason } = body;
        if (!targetUserId || typeof targetUserId !== 'number') {
            return json(400, { error: 'targetUserId is required.' });
        }
        if (!reason || !IMPERSONATION_REASONS.includes(reason as ImpersonationReason)) {
            return json(400, { error: `reason must be one of: ${IMPERSONATION_REASONS.join(', ')}` });
        }
        if (targetUserId === adminId) {
            return json(400, { error: 'Cannot impersonate yourself.' });
        }

        const [targetUser] = await db
            .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, role: users.role })
            .from(users)
            .where(eq(users.id, targetUserId))
            .limit(1);
        if (!targetUser) return json(404, { error: 'Target user not found.' });

        // Prevent privilege escalation: never impersonate another admin
        if (isAdminRole(targetUser.role)) {
            return json(403, { error: 'Cannot impersonate admin users.' });
        }

        // A user with no organisation has no workspace to look at — every tenant call would 403.
        const targetOrg = await resolveActiveOrg(db, targetUserId);
        if (!targetOrg) {
            return json(400, { error: 'This user has no workspace to view (no organisation membership).' });
        }

        // Starting over an active session replaces it — close the old one in the audit trail.
        const previous = getImpersonationSession(cookieHeader);
        if (previous && previous.realAdminId === adminId) {
            await insertAdminAuditLog({
                adminId,
                action: 'impersonate_end',
                targetType: 'user',
                targetId: previous.impersonatingUserId,
                newState: { sessionId: previous.sessionId },
                reason: 'replaced_by_new_session',
                ipAddress: ip,
                userAgent: ua,
                metadata: { sessionId: previous.sessionId },
            });
        }

        const sessionId = randomUUID();
        const targetUserName = [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ');

        const payload: ImpersonationPayload = {
            scope:                'impersonate',
            userId:               targetUserId,
            realAdminId:          adminId,
            realAdminEmail:       adminUser.email!,
            impersonatingUserId:  targetUserId,
            targetUserEmail:      targetUser.email,
            targetUserName,
            sessionId,
            reason:               reason as ImpersonationReason,
            activeOrganisationId: targetOrg.organisationId,
        };

        const token = jwt.sign(payload, jwtSecret, { expiresIn: `${IMPERSONATION_TTL_SECONDS}s` });

        await insertAdminAuditLog({
            adminId,
            action: 'impersonate_start',
            targetType: 'user',
            targetId: targetUserId,
            newState: { sessionId, reason, targetEmail: targetUser.email, organisationId: targetOrg.organisationId },
            reason,
            ipAddress: ip,
            userAgent: ua,
            metadata: { sessionId, ttlSeconds: IMPERSONATION_TTL_SECONDS },
        });

        return json(200, {
            ok: true,
            sessionId,
            targetEmail:      targetUser.email,
            targetName:       targetUserName,
            expiresInSeconds: IMPERSONATION_TTL_SECONDS,
            redirect:         '/workspace.html',
        }, {
            'Set-Cookie': `${IMPERSONATION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${IMPERSONATION_TTL_SECONDS}`,
        });
    }

    return json(400, { error: 'action must be "start" or "end".' });
});
