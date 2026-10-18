// tests/task-metering-db.test.ts
// The single task allowance's money SQL, on REAL Postgres — src/utils/work-metering.ts
// recordCompletedWork / hasTaskCapacity / grantBonusTasks (docs/task-metering.md).
//
// WHY A DATABASE TEST. One statement bumps the counter, spends bonus tasks for only the part of a
// charge past the allowance, and writes the itemised ledger row. A mistake (spending bonus while
// still under the allowance, reading the NEW bonus as what was taken, double-counting a media job
// still in flight) charges customers wrongly, and only Postgres can prove the CTE.
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`: real columns, defaults, unique
// keys; no foreign keys) in a throwaway schema, on ONE connection with search_path set to it.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that
// is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/task-metering-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { recordCompletedWork, hasTaskCapacity, getTaskUsage, grantBonusTasks } from '../src/utils/work-metering';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); }
    catch { return false; }
}

async function main() {
    console.log('Task metering — weighted charges, bonus tasks and the ledger (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `task_metering_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['usage_counters', 'task_ledger', 'task_bonus', 'media_generation_jobs', 'plans', 'master_plans']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        const ORG = 1;
        const [mp] = await sql.unsafe(`INSERT INTO master_plans (tier_key, name, monthly_price_gbp, monthly_task_limit, features, is_active)
                                       VALUES ('saver', 'Saver', 29, 30, '{}'::jsonb, true) RETURNING id`);
        await sql.unsafe(`INSERT INTO plans (organisation_id, master_plan_id, plan_name, status) VALUES (${ORG}, ${mp.id}, 'Saver', 'active')`);
        const counter = async () => Number((await sql.unsafe(`SELECT COALESCE(SUM(task_count),0) AS n FROM usage_counters WHERE organisation_id = ${ORG}`))[0].n);
        const bonus = async () => Number((await sql.unsafe(`SELECT COALESCE(SUM(bonus_tasks),0) AS n FROM task_bonus WHERE organisation_id = ${ORG}`))[0].n);

        await check('a charge under the allowance counts its weight and spends no bonus', async () => {
            await grantBonusTasks(db, ORG, 15, 'conversion');
            await recordCompletedWork(db, ORG, 'ai_video', { ref: 'job-1', assistantId: null });
            assert.strictEqual(await counter(), 20);
            assert.strictEqual(await bonus(), 15);
            const [row] = await sql.unsafe(`SELECT kind, units, bonus_units, source FROM task_ledger WHERE ref = 'job-1'`);
            assert.deepStrictEqual({ ...row }, { kind: 'ai_video', units: 20, bonus_units: 0, source: 'work' });
        });

        await check('a charge crossing the allowance spends bonus only for the part past it', async () => {
            // 20 used of 30; a 20-task video → 10 inside the allowance, 10 from bonus.
            await recordCompletedWork(db, ORG, 'ai_video', { ref: 'job-2' });
            assert.strictEqual(await counter(), 40);
            assert.strictEqual(await bonus(), 5);
            const [row] = await sql.unsafe(`SELECT bonus_units FROM task_ledger WHERE ref = 'job-2'`);
            assert.strictEqual(Number(row.bonus_units), 10);
        });

        await check('capacity = allowance left + bonus, and a heavier job than that is refused', async () => {
            const u = await getTaskUsage(db, ORG);
            assert.strictEqual(u.remaining, 5);
            assert.strictEqual(await hasTaskCapacity(db, ORG, 5), true);
            assert.strictEqual(await hasTaskCapacity(db, ORG, 20), false);
        });

        await check('bonus never goes negative when an in-flight job overruns it', async () => {
            await recordCompletedWork(db, ORG, 'x_link_post', { ref: 'post-9' });   // 10 units, 5 bonus left
            assert.strictEqual(await bonus(), 0);
            const [row] = await sql.unsafe(`SELECT bonus_units FROM task_ledger WHERE ref = 'post-9'`);
            assert.strictEqual(Number(row.bonus_units), 5);
            assert.strictEqual(await counter(), 50);   // the honest number: the work was done
        });

        await check('a media job still running is reserved against capacity', async () => {
            await grantBonusTasks(db, ORG, 25, 'admin');
            await sql.unsafe(`INSERT INTO media_generation_jobs (organisation_id, media_type, prompt, aspect_ratio, model, credit_cost, status)
                              VALUES (${ORG}, 'video', 'p', '9:16', 'm', 5, 'processing')`);
            const u = await getTaskUsage(db, ORG);
            assert.strictEqual(u.inFlight, 20);
            assert.strictEqual(u.remaining, 5);
            assert.strictEqual(await hasTaskCapacity(db, ORG, 20), false);
        });

        await check('the counter equals the sum of work rows (what reconcile-billing checks)', async () => {
            const [r] = await sql.unsafe(`SELECT SUM(units) AS n FROM task_ledger WHERE organisation_id = ${ORG} AND source = 'work'`);
            assert.strictEqual(Number(r.n), await counter());
        });

        await check('only one conversion row per org can ever exist', async () => {
            await assert.rejects(() => grantBonusTasks(db, ORG, 1, 'conversion'));
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
