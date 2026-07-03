// netlify/functions/admin-ai-credits.ts
// Epic 2, US4: admin AI-generation credit management.
//
// GET  ?targetUserId=N   → { balance, held, ledger[] }  (resolves the user's org)
// POST { targetUserId, delta, reason }  → grant (+) or deduct (−) credits; returns { balance }
//
// Cookie: aura_session (must be billing_admin, platform_admin, or super_admin).
// Unlike admin-billing-override, this needs no Stripe — credits are DB-only and per-environment.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, aiCreditLedger } from '../../db/schema';
import { getBalance, adminAdjust } from '../../src/utils/ai-credits';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';

const jwtSecret = process.env.JWT_SECRET;
const ALLOWED_ROLES = ['billing_admin', 'platform_admin', 'super_admin'];

export const handler: Handler = async (event) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // ── Auth ──────────────────────────────────────────────────────────────────
    const cookieMatch = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!cookieMatch) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    try {
        const tok = jwt.verify(cookieMatch[1], jwtSecret) as any;
        if (tok.scope === 'impersonate') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Action blocked during impersonation session.' }) };
        }
        adminId = tok.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();
    const [adminUser] = await db.select({ role: users.role }).from(users).where(eq(users.id, adminId)).limit(1);
    if (!adminUser || !ALLOWED_ROLES.includes(adminUser.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: `Requires one of: ${ALLOWED_ROLES.join(', ')}.` }) };
    }

    // ── Resolve the target user's organisation ─────────────────────────────────
    const targetUserId = Number(event.queryStringParameters?.targetUserId ?? (safeJson(event.body)?.targetUserId));
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'targetUserId (integer) required.' }) };
    }
    const [membership] = await db
        .select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations)
        .where(eq(userOrganisations.userId, targetUserId))
        .limit(1);
    if (!membership) return { statusCode: 404, body: JSON.stringify({ error: 'No organisation found for that user.' }) };
    const orgId = membership.organisationId;

    // ── GET: balance + recent ledger ───────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const { balance, held } = await getBalance(db, orgId);
        const ledger = await db
            .select({
                delta: aiCreditLedger.delta,
                reason: aiCreditLedger.reason,
                balanceAfter: aiCreditLedger.balanceAfter,
                isAutonomous: aiCreditLedger.isAutonomous,
                createdAt: aiCreditLedger.createdAt,
            })
            .from(aiCreditLedger)
            .where(eq(aiCreditLedger.organisationId, orgId))
            .orderBy(desc(aiCreditLedger.createdAt))
            .limit(20);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ balance, held, ledger }) };
    }

    // ── POST: grant / deduct ────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
        const body = safeJson(event.body) || {};
        const delta = Number(body.delta);
        const reason = (body.reason || '').trim();
        if (!Number.isInteger(delta) || delta === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'delta must be a non-zero integer.' }) };
        }
        if (!reason) return { statusCode: 400, body: JSON.stringify({ error: 'A reason is required.' }) };

        const before = await getBalance(db, orgId);
        const balance = await adminAdjust(db, { orgId, delta, userId: adminId });

        await insertAdminAuditLog({
            adminId,
            action: 'ai_credit_adjustment' as any,
            targetType: 'organisation',
            targetId: orgId,
            previousState: { balance: before.balance },
            newState: { balance },
            reason,
            ipAddress: getAdminIp(event.headers),
            userAgent: event.headers['user-agent'] || undefined,
            metadata: { targetUserId, delta },
        });

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ balance }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};

function safeJson(body: string | null): any {
    try { return JSON.parse(body || '{}'); } catch { return null; }
}
