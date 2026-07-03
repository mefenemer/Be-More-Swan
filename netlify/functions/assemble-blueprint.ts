// netlify/functions/assemble-blueprint.ts
// US-ADM-4.2.1: Blueprint Assembly Engine
//
// GET  /.netlify/functions/assemble-blueprint?assistantId=N[&force=1]
//   Returns (or reuses cached) compiled blueprint JSON for the given assistant.
//   force=1 recompiles even if a current-version cache exists.
//
// POST /.netlify/functions/assemble-blueprint?assistantId=N&action=send
//   Marks the latest blueprint as sent (records sentAt + sentByAdminId).
//
// Auth: aura_session with adminRole required.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiBlueprints } from '../../db/schema';
import { assembleBlueprint, MissingField } from '../../src/utils/blueprint';

const jwtSecret = process.env.JWT_SECRET;
const ADMIN_ROLES = ['admin', 'super_admin', 'platform_admin', 'billing_admin', 'support_agent'];

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    let adminRole: string | null;
    try {
        const payload = jwt.verify(match[1], jwtSecret) as { userId: number; adminRole?: string };
        adminId = payload.userId;
        adminRole = payload.adminRole ?? null;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    if (!adminRole || !ADMIN_ROLES.includes(adminRole)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required.' }) };
    }

    const assistantId = parseInt(event.queryStringParameters?.assistantId ?? '');
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId required.' }) };

    const db = getDb();

    // POST: mark as sent
    if (event.httpMethod === 'POST') {
        const action = event.queryStringParameters?.action;
        if (action === 'send') {
            const [latest] = await db.select().from(aiBlueprints)
                .where(eq(aiBlueprints.assistantId, assistantId))
                .orderBy(desc(aiBlueprints.compiledAt))
                .limit(1);
            if (!latest) return { statusCode: 404, body: JSON.stringify({ error: 'No blueprint found.' }) };
            if ((latest.missingFields as MissingField[]).some(f => f.severity === 'blocking')) {
                return { statusCode: 422, body: JSON.stringify({ error: 'Blueprint has blocking gaps. Resolve them before sending.' }) };
            }
            await db.update(aiBlueprints)
                .set({ sentAt: new Date(), sentByAdminId: adminId })
                .where(eq(aiBlueprints.id, latest.id));
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
        }
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
    }

    // GET: compile or return history
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const history = event.queryStringParameters?.history === '1';
    if (history) {
        const rows = await db.select().from(aiBlueprints)
            .where(eq(aiBlueprints.assistantId, assistantId))
            .orderBy(desc(aiBlueprints.compiledAt))
            .limit(20);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
    }

    const dryRun = event.queryStringParameters?.dryRun === '1';
    const triggerType = dryRun ? 'dry-run' : 'admin-manual';

    try {
        const result = await assembleBlueprint(assistantId, String(adminId), triggerType);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
        };
    } catch (err) {
        console.error('[assemble-blueprint]', err);
        return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
    }
};
