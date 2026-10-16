// netlify/functions/admin-ai-credits.ts
// Epic 2, US4: admin AI-generation credit management.
//
// GET  ?targetUserId=N   → { balance, held, ledger[] }  (resolves the user's org)
// POST { targetUserId, delta, reason }  → grant (+) or deduct (−) credits; returns { balance }
//
// Cookie: aura_session (role must clear 'manage_ai_credits' — billing_admin and above).
// Unlike admin-billing-override, this needs no Stripe — credits are DB-only and per-environment.
//
// Single task allowance ('unified_task_metering', docs/task-metering.md): the same endpoints
// adjust BONUS TASKS instead (task_bonus, non-expiring, spent after the monthly allowance), and
// the ledger is the org's recent task_ledger rows. Responses carry `unit: 'tasks'`.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, aiCreditLedger, taskLedger } from '../../db/schema';
import { getTaskUsage, grantBonusTasks } from '../../src/utils/work-metering';
import { isUnifiedTaskMetering } from '../../src/utils/task-metering-flag';
import { getBalance, adminAdjust } from '../../src/utils/ai-credits';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { withLambda } from '@netlify/aws-lambda-compat';
import { requirePermission } from '../../src/utils/rbac';

const jwtSecret = process.env.JWT_SECRET;
// Gate: rbac.ts is the single source of truth for admin authorisation.

export default withLambda(async (event) => {
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
    const denied = requirePermission(adminUser?.role, 'manage_ai_credits');
    if (denied) return denied;

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

    const tasks = await isUnifiedTaskMetering(orgId);

    // ── GET: balance + recent ledger ───────────────────────────────────────────
    if (event.httpMethod === 'GET' && tasks) {
        const usage = await getTaskUsage(db, orgId);
        const rows = await db.select({
                units: taskLedger.units, kind: taskLedger.kind, source: taskLedger.source,
                bonusUnits: taskLedger.bonusUnits, note: taskLedger.note, createdAt: taskLedger.createdAt,
            })
            .from(taskLedger)
            .where(eq(taskLedger.organisationId, orgId))
            .orderBy(desc(taskLedger.createdAt))
            .limit(20);
        // Same row shape the admin modal already renders: a grant is +, work is −.
        const ledger = rows.map(r => ({
            delta: r.source === 'work' ? -r.units : r.units,
            reason: r.source === 'work' ? r.kind : `${r.source}${r.note ? ` — ${r.note}` : ''}`,
            balanceAfter: null,
            isAutonomous: false,
            createdAt: r.createdAt,
        }));
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            unit: 'tasks', balance: usage.bonus, held: usage.inFlight,
            used: usage.used, limit: usage.limit, ledger,
        }) };
    }
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

        if (tasks) {
            const beforeBonus = (await getTaskUsage(db, orgId)).bonus;
            const bonus = await grantBonusTasks(db, orgId, delta, 'admin', { userId: adminId, note: reason.slice(0, 200) });
            await insertAdminAuditLog({
                adminId,
                action: 'ai_credit_adjustment' as any,
                targetType: 'organisation',
                targetId: orgId,
                previousState: { bonusTasks: beforeBonus },
                newState: { bonusTasks: bonus },
                reason,
                ipAddress: getAdminIp(event.headers),
                userAgent: event.headers['user-agent'] || undefined,
                metadata: { targetUserId, delta, unit: 'tasks' },
            });
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unit: 'tasks', balance: bonus }) };
        }

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
});

function safeJson(body: string | null): any {
    try { return JSON.parse(body || '{}'); } catch { return null; }
}
