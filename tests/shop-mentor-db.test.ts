// tests/shop-mentor-db.test.ts
// The Business Mentor's shop facts on REAL Postgres (online shop Phase 2, slice 8; src/utils/shop-mentor.ts): no shop
// → null; best seller of the week (at least 2 sold); low and sold out; "not sold in 60 days" only for buyable products
// at least 60 days old, only when the shop sold something in that time, never another workspace's orders.
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`; no foreign keys) in a throwaway schema, search_path set
// to it. org_products' stock columns are raw SQL (db/z-shop-stock.sql), so they are added to the copy.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/shop-mentor-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { loadShopWatch } from '../src/utils/shop-mentor';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); }
    catch { return false; }
}

async function main() {
    console.log('The Mentor watches the shop: best seller, stock, not sold in 60 days (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `shop_mentor_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['ai_assistants', 'site_orders', 'site_order_lines', 'org_products']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`ALTER TABLE ${schema}.org_products ADD COLUMN IF NOT EXISTS stock INTEGER, ADD COLUMN IF NOT EXISTS low_stock_at INTEGER`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const ORG = 31, OTHER = 32;
        const product = async (org: number, name: string, o: { stock?: number | null; low?: number | null; ageDays?: number } = {}) => Number((await sql.unsafe(
            `INSERT INTO org_products (organisation_id, name, price_type, price_amount, price_currency, stock, low_stock_at, created_at)
             VALUES ($1, $2, 'fixed', 1200, 'GBP', $3, $4, now() - make_interval(days => $5)) RETURNING id`, [org, name, o.stock ?? null, o.low ?? null, o.ageDays ?? 120]))[0].id);
        let n = 0;
        const sell = async (org: number, productId: number | null, name: string, qty: number, daysAgo: number) => {
            const [o] = await sql.unsafe(
                `INSERT INTO site_orders (site_id, organisation_id, stripe_account_id, checkout_session_id, item_name, quantity, amount_total, currency, status, created_at)
                 VALUES (1, $1, 'acct', $2, $3, $4, 1200, 'gbp', 'paid', now() - make_interval(days => $5)) RETURNING id`, [org, `cs_m_${++n}`, name, qty, daysAgo]);
            if (productId) await sql.unsafe(`INSERT INTO site_order_lines (order_id, organisation_id, product_id, item_name, unit_amount, quantity) VALUES ($1, $2, $3, $4, 1200, $5)`, [o.id, org, productId, name, qty]);
        };

        await check('no Shopkeeper and no orders in 90 days → null (no shop to watch)', async () => {
            await product(ORG, 'Unsold thing');
            assert.strictEqual(await loadShopWatch(db, ORG), null);
        });

        const FIG = await product(ORG, 'Fig candle', { stock: 20, low: 3 });
        const LAV = await product(ORG, 'Lavender candle', { stock: 2, low: 3 });
        const MUG = await product(ORG, 'Mug', { stock: 0 });
        const CEDAR = await product(ORG, 'Cedar candle', { stock: 10 });
        await product(ORG, 'New candle', { stock: 10, ageDays: 10 });
        await sell(ORG, FIG, 'Fig candle', 4, 2);
        await sell(ORG, FIG, 'Fig candle', 2, 5);
        await sell(ORG, LAV, 'Lavender candle', 1, 3);
        await sell(ORG, CEDAR, 'Cedar candle', 1, 75);           // sold, but before the 60 days
        await sell(OTHER, null, 'Cedar candle', 5, 1);           // another workspace's sale never counts

        await check('best seller of the week, low stock and sold out', async () => {
            const w = await loadShopWatch(db, ORG);
            assert.deepStrictEqual(w?.bestSeller, { name: 'Fig candle', units: 6 });
            assert.deepStrictEqual(w?.low, [{ name: 'Lavender candle', left: 2 }]);
            assert.deepStrictEqual(w?.soldOut, ['Mug']);
        });
        await check('not sold in 60 days: old enough and buyable only (not the new one, not the sold-out one, not one that sold)', async () => {
            const names = (await loadShopWatch(db, ORG))!.slow.map((s) => s.name).sort();
            assert.deepStrictEqual(names, ['Cedar candle', 'Unsold thing']);
            assert.ok(!names.includes('Mug') && !names.includes('New candle') && !names.includes('Fig candle'));
            void MUG;
        });
        await check('a Buy-button order (no lines) counts as a sale by its item name', async () => {
            await sell(ORG, null, 'Unsold thing', 1, 4);
            assert.deepStrictEqual((await loadShopWatch(db, ORG))!.slow.map((s) => s.name), ['Cedar candle']);
        });
        await check('fewer than 2 sold in the week → no best seller; nothing sold in 60 days → nobody is "slow"', async () => {
            const QUIET = 33;
            await sql.unsafe(`INSERT INTO ai_assistants (id, user_id, organisation_id, name, model, configuration) VALUES (700, 1, ${QUIET}, 'Keeper', 'x', '{"type":"shopkeeper"}'::jsonb)`);
            const P = await product(QUIET, 'Lonely candle', { stock: 5 });
            await sell(QUIET, P, 'Lonely candle', 1, 2);
            let w = await loadShopWatch(db, QUIET);
            assert.strictEqual(w?.bestSeller, null);
            await sql.unsafe(`UPDATE site_orders SET created_at = now() - interval '70 days' WHERE organisation_id = ${QUIET}`);
            w = await loadShopWatch(db, QUIET);
            assert.ok(w, 'an active Shopkeeper keeps the shop watched');
            assert.deepStrictEqual(w!.slow, [], 'a shop that sold nothing in 60 days is new or quiet, not "slow" per product');
        });
    } finally {
        await sql.unsafe(`SET search_path TO public`).catch(() => {});
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
        await closeDbPools();
    }
    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
