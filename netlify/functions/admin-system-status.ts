// admin-system-status.ts
// GET — super_admin only. Live status of every external system for THIS deployment. The registry
// and the checks live in src/utils/system-registry.ts (shared with the System Map, 2026-11-12).

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';
import { hasPermission } from '../../src/utils/rbac';
import { systemStatus } from '../../src/utils/system-registry';

const jwtSecret = process.env.JWT_SECRET;
const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ── super_admin gate (mirrors admin-api requireAdmin, but super_admin only) ──
async function requireSuperAdmin(event: Parameters<Handler>[0]): Promise<boolean> {
    if (!jwtSecret) return false;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return false;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; }
    catch { return false; }
    try {
        const db = getDb();
        const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
        return hasPermission(row?.role, 'view_system_status');
    } catch { return false; }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
    if (!(await requireSuperAdmin(event))) return json(403, { error: 'Forbidden' });
    return json(200, await systemStatus(event.headers?.host || event.headers?.['x-forwarded-host']));
});
