// tests/partner-start-db.test.ts
// Starting a partnership on REAL Postgres — src/utils/partner-start.ts (owner 2026-11-24; review of #838).
// Same harness as tests/partner-ledger-db.test.ts: copies of the tables in a throwaway schema, LOCAL database only.
//
// Run:  npx tsx tests/partner-start-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { startPartnershipIfReady } from '../src/utils/partner-start';
import { PARTNER_TERMS_VERSION } from '../src/config/partner-terms';

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}
const TABLES = ['users', 'partners', 'partner_rate_periods', 'partner_pending_rates'];
const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function main() {
    console.log('Partner start on acceptance (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }
    const schema = `partner_start_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of TABLES) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const v = PARTNER_TERMS_VERSION;
        await sql.unsafe(`INSERT INTO partners (id, status, terms_version) VALUES
            (1, 'approved', '${v}'), (2, 'approved', '1.2'), (3, 'approved', '${v}'), (4, 'suspended', '${v}')`);
        await sql.unsafe(`INSERT INTO partner_pending_rates (partner_id, rate_bps, cost_deduction_bps, duration_months, window_months) VALUES
            (1, 5000, 2000, 12, 12), (3, 4000, 2000, 12, 12)`);
        // Partner 3 already has a dated special rate covering the window → the waiting rate must NOT start (no overlap).
        await sql.unsafe(`INSERT INTO partner_rate_periods (partner_id, rate_bps, cost_deduction_bps, duration_months, starts_at, ends_at) VALUES (3, 3000, 2000, 12, '2026-10-01', NULL)`);

        await check('approved + current terms: starts, the waiting rate becomes a dated period for its window, atomically', async () => {
            const out = await startPartnershipIfReady(db, 1, d('2026-12-03'));
            assert.strictEqual(out.started, true);
            const [p] = await sql`SELECT partner_since::text AS s FROM partners WHERE id = 1`;
            assert.ok(String(p.s).startsWith('2026-12-03'));
            const periods = await sql`SELECT rate_bps, duration_months, starts_at::text AS s, ends_at::text AS e FROM partner_rate_periods WHERE partner_id = 1`;
            assert.strictEqual(periods.length, 1);
            assert.strictEqual(periods[0].rate_bps, 5000);
            assert.ok(String(periods[0].s).startsWith('2026-12-03') && String(periods[0].e).startsWith('2027-12-03'));
            assert.strictEqual((await sql`SELECT 1 FROM partner_pending_rates WHERE partner_id = 1`).length, 0);
        });
        await check('a second call changes nothing (idempotent)', async () => {
            assert.strictEqual((await startPartnershipIfReady(db, 1, d('2027-01-01'))).started, false);
            assert.strictEqual((await sql`SELECT 1 FROM partner_rate_periods WHERE partner_id = 1`).length, 1);
        });
        await check('older terms accepted: does not start', async () => {
            assert.strictEqual((await startPartnershipIfReady(db, 2, d('2026-12-03'))).started, false);
            const [p] = await sql`SELECT partner_since FROM partners WHERE id = 2`;
            assert.strictEqual(p.partner_since, null);
        });
        await check('a waiting rate that would overlap a dated one is NOT started; it stays for an admin', async () => {
            const out = await startPartnershipIfReady(db, 3, d('2026-12-03'));
            assert.deepStrictEqual([out.started, out.rateConflict], [true, true]);
            assert.strictEqual((await sql`SELECT 1 FROM partner_rate_periods WHERE partner_id = 3`).length, 1, 'no overlapping period created');
            assert.strictEqual((await sql`SELECT 1 FROM partner_pending_rates WHERE partner_id = 3`).length, 1, 'waiting rate kept');
        });
        await check('suspended: does not start; once reinstated (approved) it does', async () => {
            assert.strictEqual((await startPartnershipIfReady(db, 4, d('2026-12-03'))).started, false);
            await sql`UPDATE partners SET status = 'approved' WHERE id = 4`;
            assert.strictEqual((await startPartnershipIfReady(db, 4, d('2026-12-10'))).started, true);
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}
main().catch((err) => { console.error(err); process.exit(1); });
