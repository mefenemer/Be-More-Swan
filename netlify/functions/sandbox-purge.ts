// netlify/functions/sandbox-purge.ts
// Epic: Superadmin Environment Management — US4 (Sandbox Data Purge) + US5.4 (reseed).
//
// POST /.netlify/functions/sandbox-purge
//   Headers: X-Environment: sandbox  (REQUIRED — request is rejected otherwise)
//   Body: { confirm: "PURGE SANDBOX", reseed?: boolean }
//   → { ok: true, truncatedTables: number, stripe: {...}, reseed?: SeedResult }
//
// Hard-deletes (TRUNCATE) every table in the sandbox database and deactivates Stripe
// TEST products/prices + deletes test clocks. Optionally re-runs the master-data seed.
//
// SAFETY — this can NEVER touch production. Three independent guards must all hold:
//   1. caller is super_admin
//   2. the resolved request environment is 'sandbox'
//   3. SANDBOX_DATABASE_URL is set AND differs from NETLIFY_DATABASE_URL
// plus a typed confirmation string in the body.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { resolveEnvironment, runWithEnvironment, currentEnv } from '../../src/utils/env-context';
import { getStripe, stripeKeyAvailable } from '../../src/utils/stripe';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { runSeed } from '../../seed/run-seed';

const jwtSecret = process.env.JWT_SECRET;
const CONFIRM_PHRASE = 'PURGE SANDBOX';

async function requireSuperAdmin(event: any): Promise<number | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; }
    catch { return null; }
    // Role lookup MUST hit live (default context).
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.role === 'super_admin' ? userId : null;
}

/** Archive all Stripe TEST products & prices and delete test clocks (best-effort). */
async function purgeStripeTest(): Promise<{ productsArchived: number; pricesArchived: number; clocksDeleted: number }> {
    const stats = { productsArchived: 0, pricesArchived: 0, clocksDeleted: 0 };
    if (!stripeKeyAvailable()) return stats;
    const stripe = getStripe();

    // Prices can't be deleted — only deactivated.
    for await (const price of stripe.prices.list({ active: true, limit: 100 })) {
        try { await stripe.prices.update(price.id, { active: false }); stats.pricesArchived++; } catch { /* best-effort */ }
    }
    for await (const product of stripe.products.list({ active: true, limit: 100 })) {
        try { await stripe.products.update(product.id, { active: false }); stats.productsArchived++; } catch { /* best-effort */ }
    }
    try {
        for await (const clock of stripe.testHelpers.testClocks.list({ limit: 100 })) {
            try { await stripe.testHelpers.testClocks.del(clock.id); stats.clocksDeleted++; } catch { /* best-effort */ }
        }
    } catch { /* testHelpers unavailable on live key — never reached in sandbox */ }
    return stats;
}

async function truncateAllTables(): Promise<number> {
    const db = getDb();
    const rows = await db.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_%'`,
    );
    const tables = (rows as unknown as { tablename: string }[]).map((r) => r.tablename);
    if (tables.length === 0) return 0;
    const quoted = tables.map((t) => `"${t.replace(/"/g, '""')}"`).join(', ');
    // RESTART IDENTITY resets serial PKs; CASCADE handles FK ordering.
    await db.execute(sql.raw(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`));
    return tables.length;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'POST required.' }) };
    }

    // Guard 1: super_admin
    const adminId = await requireSuperAdmin(event);
    if (!adminId) return { statusCode: 403, body: JSON.stringify({ error: 'super_admin required.' }) };

    // Guard 2: resolved env must be sandbox
    const env = resolveEnvironment(event.headers, { allowSandbox: true });
    if (env !== 'sandbox') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Purge is only available in Sandbox mode (X-Environment: sandbox).' }) };
    }

    // Guard 3: sandbox DB must be provisioned AND distinct from production
    const sandboxUrl = process.env.SANDBOX_DATABASE_URL;
    if (!sandboxUrl || sandboxUrl === process.env.NETLIFY_DATABASE_URL) {
        return { statusCode: 500, body: JSON.stringify({ error: 'SANDBOX_DATABASE_URL is not configured or matches production — refusing to purge.' }) };
    }

    // Typed confirmation
    let body: { confirm?: string; reseed?: boolean };
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }
    if (body.confirm !== CONFIRM_PHRASE) {
        return { statusCode: 422, body: JSON.stringify({ error: `Confirmation required: type "${CONFIRM_PHRASE}".` }) };
    }

    return runWithEnvironment('sandbox', async () => {
        // Final defence-in-depth: assert the active context really is sandbox.
        if (currentEnv() !== 'sandbox') {
            return { statusCode: 500, body: JSON.stringify({ error: 'Environment context mismatch — aborting.' }) };
        }

        const truncatedTables = await truncateAllTables();
        const stripe = await purgeStripeTest();

        let reseed: Awaited<ReturnType<typeof runSeed>> | undefined;
        if (body.reseed) {
            reseed = await runSeed({ actorId: adminId, syncStripe: true, log: () => {} });
        }

        // Audit is forced to live inside insertAdminAuditLog.
        void insertAdminAuditLog({
            adminId,
            action: 'sandbox_purge',
            targetType: 'sandbox_environment',
            newState: { truncatedTables, stripe, reseeded: !!body.reseed },
            ipAddress: getAdminIp(event.headers as any),
            userAgent: event.headers['user-agent'] || undefined,
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, truncatedTables, stripe, reseed }),
        };
    });
};
