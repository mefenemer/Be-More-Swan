// netlify/functions/sandbox-seed.ts
// Epic: Superadmin Environment Management — US5 (Master Data Seeding / Sandbox Reset).
//
// POST /.netlify/functions/sandbox-seed
//   Headers: X-Environment: sandbox  (REQUIRED)
//   Body: { syncStripe?: boolean }   (default true)
//   → { ok: true, result: SeedResult }
//
// Populates the sandbox database with production-equivalent master data from the
// version-controlled JSON (seed/data/), validated by Zod, and (by default) creates
// the matching Stripe TEST Products/Prices so checkouts work immediately (US5.3).
//
// Only super_admins, only in sandbox — never touches production.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { resolveEnvironment, runWithEnvironment } from '../../src/utils/env-context';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { runSeed } from '../../seed/run-seed';

const jwtSecret = process.env.JWT_SECRET;

async function requireSuperAdmin(event: any): Promise<number | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; }
    catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.role === 'super_admin' ? userId : null;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'POST required.' }) };
    }

    const adminId = await requireSuperAdmin(event);
    if (!adminId) return { statusCode: 403, body: JSON.stringify({ error: 'super_admin required.' }) };

    const env = resolveEnvironment(event.headers, { allowSandbox: true });
    if (env !== 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Seeding is only available in Sandbox mode (X-Environment: sandbox).' }) };
    }
    if (!process.env.SANDBOX_DATABASE_URL) {
        return { statusCode: 500, body: JSON.stringify({ error: 'SANDBOX_DATABASE_URL is not configured.' }) };
    }

    let body: { syncStripe?: boolean };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    return runWithEnvironment('sandbox', async () => {
        try {
            const result = await runSeed({ actorId: adminId, syncStripe: body.syncStripe ?? true, log: () => {} });

            void insertAdminAuditLog({
                adminId,
                action: 'sandbox_seed',
                targetType: 'sandbox_environment',
                newState: result as any,
                ipAddress: getAdminIp(event.headers as any),
                userAgent: event.headers['user-agent'] || undefined,
            });

            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, result }) };
        } catch (err: any) {
            // Zod validation errors carry a readable .message
            return { statusCode: 422, body: JSON.stringify({ error: err?.message || 'Seed failed.' }) };
        }
    });
};
