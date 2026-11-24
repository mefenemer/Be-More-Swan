// tests/partner-start-db.test.ts
// Starting a partnership on REAL Postgres — src/utils/partner-start.ts (owner 2026-11-24; review of #838).
// Same harness as tests/partner-ledger-db.test.ts: copies of the tables in a throwaway schema, LOCAL database only.
//
// Run:  npx tsx tests/partner-start-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { partnerLinkBlocked, startPartnershipIfReady } from '../src/utils/partner-start';
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
        // approved_at 1 Dec, accepted 2 Dec (after approval) — except partner 5: only the application tick (before approval).
        await sql.unsafe(`INSERT INTO partners (id, status, terms_version, approved_at, terms_accepted_at) VALUES
            (1, 'approved', '${v}', '2026-12-01', '2026-12-02'), (2, 'approved', '1.2', '2026-12-01', '2026-12-02'),
            (3, 'approved', '${v}', '2026-12-01', '2026-12-02'), (4, 'suspended', '${v}', '2026-12-01', '2026-12-02'),
            (5, 'approved', '${v}', '2026-12-01', '2026-11-20')`);
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
        await check('only the application tick (accepted before approval): does not start', async () => {
            assert.strictEqual((await startPartnershipIfReady(db, 5, d('2026-12-03'))).started, false);
        });
                await check('suspended: does not start; reinstated (approved_at = now, as the real code sets it) still waits for a NEW acceptance', async () => {
            assert.strictEqual((await startPartnershipIfReady(db, 4, d('2026-12-03'))).started, false);
            await sql`UPDATE partners SET status = 'approved', approved_at = '2026-12-10' WHERE id = 4`;
            assert.strictEqual((await startPartnershipIfReady(db, 4, d('2026-12-10'))).started, false, 'the old acceptance predates the reinstatement');
            await sql`UPDATE partners SET terms_accepted_at = '2026-12-11' WHERE id = 4`;
            assert.strictEqual((await startPartnershipIfReady(db, 4, d('2026-12-11'))).started, true, 'accepted again after reinstatement → starts');
        });
        await check('partnerLinkBlocked: an approved/suspended partner with no start date can\'t get their link; started or not approved/suspended can (review of #850)', async () => {
            await sql.unsafe(`INSERT INTO partners (id, user_id, status, partner_since) VALUES
                (11, 501, 'approved', NULL), (12, 502, 'suspended', NULL), (13, 503, 'approved', '2026-12-01'), (14, 504, 'rejected', NULL)`);
            assert.strictEqual(await partnerLinkBlocked(db, 501), true);
            assert.strictEqual(await partnerLinkBlocked(db, 502), true);
            assert.strictEqual(await partnerLinkBlocked(db, 503), false);
            assert.strictEqual(await partnerLinkBlocked(db, 504), false, 'not approved/suspended (CI schema check has no \'ended\'; same branch)');
            assert.strictEqual(await partnerLinkBlocked(db, 999), false, 'not a partner (ordinary customer)');
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} passed`);
}
main().catch((err) => { console.error(err); process.exit(1); });
