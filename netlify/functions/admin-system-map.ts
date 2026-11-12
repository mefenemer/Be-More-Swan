// admin-system-map.ts — Admin → Systems & connections, the System Map (docs/system-map-plan.md).
//   GET                         → the whole map: every system, health, version, spend (30 days + all time,
//                                 GBP), models with the roles using them, tasks, fixed bills.
//   POST { action: 'add_fixed' | 'end_fixed' | 'delete_fixed', … } → change a monthly bill.
//   POST { action: 'check_now', systemKeys: [...] | 'all' } → queue "better options" checks (Phase 3)
//   POST { action: 'add_decision' | 'retire_decision', … }   → decisions the checks must respect
//   The Systems chat's cards send exactly these bodies (GUI + chat parity).
// Cookie: aura_session; `view_system_status` (super admin), never during impersonation for writes.

import jwt from 'jsonwebtoken';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { systemDecisions, systemFixedCosts, systemReviews, users } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { loadSystemMap } from '../../src/utils/system-map-data';
import { SERVICES } from '../../src/utils/system-registry';
import { validateFixedCostRequest } from '../../src/utils/system-map';
import { queueSystemReviews, startReviewWorker, validateReviewRequest } from '../../src/utils/system-review';
import { resolveBaseUrl } from '../../src/utils/base-url';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

async function who(event: { headers: Record<string, string | undefined> }): Promise<{ userId: number; impersonating: boolean } | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const m = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!m) return null;
    let tok: { userId: number; scope?: string };
    try { tok = jwt.verify(m[1], secret) as { userId: number; scope?: string }; } catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, tok.userId)).limit(1);
    if (!hasPermission(row?.role, 'view_system_status')) return null;
    return { userId: tok.userId, impersonating: tok.scope === 'impersonate' };
}

export default withLambda(async (event) => {
    const me = await who(event as any);
    if (!me) return json(403, { error: 'Super admin access required.' });
    const db = getDb();

    if (event.httpMethod === 'GET') {
        return json(200, await loadSystemMap(db, event.headers?.host || event.headers?.['x-forwarded-host']));
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    if (me.impersonating) return json(403, { error: 'Action blocked during impersonation session.' });

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
    const known = SERVICES.map((s) => s.key);

    // ── Better options (Phase 3) ────────────────────────────────────────────────────────────────
    if (['check_now', 'add_decision', 'retire_decision'].includes(String(body.action))) {
        const r = validateReviewRequest(body, known);
        if ('error' in r) return json(400, { error: r.error });
        const req = r.ok;
        if (req.action === 'check_now') {
            const ids = await queueSystemReviews(db, req.systemKeys, body.via === 'chat' ? 'chat' : 'manual', me.userId);
            if (!ids.length) return json(200, { ok: true, queued: 0, note: 'A check is already running for that.' });
            const problem = await startReviewWorker(resolveBaseUrl(event.headers as Record<string, string | undefined>), ids);
            if (problem) {
                // Don't leave rows that will never run looking "queued".
                await db.update(systemReviews).set({ status: 'failed', error: problem, finishedAt: new Date() }).where(inArray(systemReviews.id, ids));
                return json(503, { error: problem });
            }
            return json(200, { ok: true, queued: ids.length });
        }
        if (req.action === 'add_decision') {
            const [row] = await db.insert(systemDecisions).values({ systemKey: req.systemKey, decision: req.decision, createdBy: me.userId }).returning({ id: systemDecisions.id });
            return json(200, { ok: true, id: row.id });
        }
        const res = await db.update(systemDecisions).set({ retiredAt: new Date() })
            .where(and(eq(systemDecisions.id, req.id), isNull(systemDecisions.retiredAt))).returning({ id: systemDecisions.id });
        if (!res.length) return json(404, { error: 'That decision was not found.' });
        return json(200, { ok: true });
    }

    const v = validateFixedCostRequest(body, known);
    if ('error' in v) return json(400, { error: v.error });
    const req = v.ok;

    if (req.action === 'add_fixed') {
        const [row] = await db.insert(systemFixedCosts).values({
            systemKey: req.systemKey, label: req.label, amountMonthly: req.amountMonthly.toFixed(2), currency: req.currency,
            startedOn: req.startedOn, endedOn: req.endedOn, note: req.note, createdBy: me.userId,
        }).returning({ id: systemFixedCosts.id });
        return json(200, { ok: true, id: row.id });
    }
    const [existing] = await db.select().from(systemFixedCosts).where(eq(systemFixedCosts.id, req.id)).limit(1);
    if (!existing) return json(404, { error: 'That bill was not found.' });
    if (req.action === 'end_fixed') {
        if (req.endedOn < existing.startedOn) return json(400, { error: 'The end date must be on or after the start.' });
        await db.update(systemFixedCosts).set({ endedOn: req.endedOn, updatedAt: new Date() }).where(eq(systemFixedCosts.id, req.id));
        return json(200, { ok: true });
    }
    await db.delete(systemFixedCosts).where(eq(systemFixedCosts.id, req.id));
    return json(200, { ok: true });
});
