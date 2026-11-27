// tests/shop-stock-alerts-db.test.ts
// "Stock that talks" on REAL Postgres (online shop Phase 2, slice 2; feature request #35): takeStock and
// takeOptionStock return what stockCrossing needs — before, after and the low-stock level, an option's being
// its PRODUCT's — so a run of orders alerts exactly once into low and once at sold out.
//
// HOW. Copies of org_products and product_options (`LIKE … INCLUDING DEFAULTS`) in a throwaway schema, plus the
// raw-SQL stock columns db/z-shop-stock.sql adds (not in db/schema.ts), on ONE connection with search_path set.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/shop-stock-alerts-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { takeStock } from '../src/utils/shop-stock';
import { takeOptionStock } from '../src/utils/shop-options';
import { stockCrossing } from '../src/utils/shop-stock-alerts';

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
    console.log('Stock that talks — stock taken per order, alerts once per crossing (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `shop_stock_alerts_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['org_products', 'product_options']) await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS)`);
        await sql.unsafe(`ALTER TABLE ${schema}.org_products ADD COLUMN IF NOT EXISTS stock INTEGER, ADD COLUMN IF NOT EXISTS low_stock_at INTEGER`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const ORG = 3;

        const [p] = await sql.unsafe(`INSERT INTO org_products (organisation_id, kind, name, stock, low_stock_at) VALUES (${ORG}, 'product', 'Mug', 5, 3) RETURNING id`);
        const mug = Number(p.id);
        const [q] = await sql.unsafe(`INSERT INTO org_products (organisation_id, kind, name, low_stock_at) VALUES (${ORG}, 'product', 'Fig candle', 2) RETURNING id`);
        const [opt] = await sql.unsafe(`INSERT INTO product_options (organisation_id, product_id, label, stock) VALUES (${ORG}, ${Number(q.id)}, 'Large', 3) RETURNING id`);
        const large = Number(opt.id);

        await check('a product: 5 → 4 (nothing) → 3 (low, once) → 2 (nothing) → 0 (sold out, once; 2 asked, 2 left)', async () => {
            const kinds: Array<string | null> = [];
            for (const qty of [1, 1, 1, 2]) kinds.push(stockCrossing(await takeStock(db, ORG, mug, qty), 'Mug')?.kind ?? null);
            assert.deepStrictEqual(kinds, [null, 'low', null, 'sold_out']);
            const again = await takeStock(db, ORG, mug, 1);
            assert.deepStrictEqual({ ...again, kind: stockCrossing(again, 'Mug')?.kind ?? null }, { before: 0, after: 0, lowStockAt: 3, oversold: true, kind: null });
        });
        await check('an option warns at its PRODUCT\'s level: 3 → 2 (low) → 0 (sold out)', async () => {
            const a = await takeOptionStock(db, ORG, large, 1);
            assert.deepStrictEqual(a, { before: 3, after: 2, lowStockAt: 2, oversold: false });
            assert.strictEqual(stockCrossing(a, 'Fig candle — Large')?.kind, 'low');
            assert.strictEqual(stockCrossing(await takeOptionStock(db, ORG, large, 2), 'Fig candle — Large')?.kind, 'sold_out');
        });
        await check('another workspace can\'t take this stock; an option still takes stock when the level can\'t be read', async () => {
            assert.strictEqual(await takeStock(db, ORG + 1, mug, 1), null);
            assert.strictEqual(await takeOptionStock(db, ORG + 1, large, 1), null);
            await sql.unsafe(`UPDATE product_options SET stock = 4 WHERE id = ${large}`);
            await sql.unsafe(`ALTER TABLE org_products RENAME COLUMN low_stock_at TO low_stock_gone`);
            const r = await takeOptionStock(db, ORG, large, 1);
            await sql.unsafe(`ALTER TABLE org_products RENAME COLUMN low_stock_gone TO low_stock_at`);
            assert.deepStrictEqual(r, { before: 4, after: 3, lowStockAt: null, oversold: false });
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
