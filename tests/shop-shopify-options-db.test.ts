// tests/shop-shopify-options-db.test.ts
// Bring your Shopify shop across on REAL Postgres (online shop Phase 2, slice 9; src/utils/site-import-store.ts
// addImportedProducts): a ticked product from the feed lands in Business Information with its description and its
// variants as options (own prices, unavailable sold out, stock otherwise empty); a product without a fixed price gets
// no options; an existing product by name is left alone.
//
// HOW. Copies of the tables it touches (`LIKE … INCLUDING ALL`; no foreign keys) in a throwaway schema, search_path set
// to it. org_products' stock columns are raw SQL (db/z-shop-stock.sql), added to the copy.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job) — never staging/prod.
//
// Run:  npx tsx tests/shop-shopify-options-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { addImportedProducts } from '../src/utils/site-import-store';

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
    console.log('Shopify import: descriptions and options into Business Information (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `shop_shopify_options_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['site_imports', 'org_products', 'product_options', 'content_assets']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
        }
        await sql.unsafe(`ALTER TABLE ${schema}.org_products ADD COLUMN IF NOT EXISTS stock INTEGER, ADD COLUMN IF NOT EXISTS low_stock_at INTEGER`);
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;
        const ORG = 41, SITE = 410;
        const products = [
            { name: 'Logo T-shirt', price: '£20.00', href: 'https://old.example/products/logo-tee', image: null, description: 'Soft organic cotton.\nUnisex fit',
              options: { group: 'Size', options: [{ label: 'S', price: null, soldOut: false }, { label: 'M', price: null, soldOut: true }, { label: 'L', price: 22.5, soldOut: false }] } },
            { name: 'Gift card', price: 'Ask us', href: null, image: null, description: null,
              options: { group: 'Amount', options: [{ label: '£10', price: 10, soldOut: false }, { label: '£20', price: 20, soldOut: false }] } },
            { name: 'Mug', price: '£9.00', href: null, image: null, description: 'Stoneware.', options: null },
        ];
        await sql.unsafe(`INSERT INTO site_imports (site_id, organisation_id, source_url, pictures, status, report) VALUES (${SITE}, ${ORG}, 'https://old.example', 'skip', 'ready', $1::jsonb)`,
            [JSON.stringify({ products })]);
        await sql.unsafe(`INSERT INTO org_products (organisation_id, name, description) VALUES (${ORG}, 'Mug', 'My own words')`);
        const site = { id: SITE, organisationId: ORG } as never;
        const row = async (name: string) => (await sql.unsafe(`SELECT id, price_type, price_amount, description FROM org_products WHERE organisation_id = ${ORG} AND name = $1`, [name]))[0];

        let r: Awaited<ReturnType<typeof addImportedProducts>>;
        await check('ticked products added: description kept, the T-shirt with its 3 sizes; the Mug already there by name, untouched', async () => {
            r = await addImportedProducts(db, site, { userId: null });
            assert.ok(r.ok, JSON.stringify(r));
            assert.deepStrictEqual(r.ok && [r.added, r.skipped, r.withOptions], [2, 1, 1]);
            const t = await row('Logo T-shirt');
            assert.deepStrictEqual([t.price_type, Number(t.price_amount), t.description], ['fixed', 2000, 'Soft organic cotton.\nUnisex fit']);
            assert.strictEqual((await row('Mug')).description, 'My own words', 'never overwritten');
        });
        await check('the options: own prices (null = the product\'s), the unavailable one sold out (stock 0), the rest stock empty', async () => {
            const t = await row('Logo T-shirt');
            const opts = await sql.unsafe(`SELECT group_name, label, price_amount, stock FROM product_options WHERE product_id = ${t.id} AND status = 'active' ORDER BY sort_order`);
            assert.deepStrictEqual(opts.map((o) => [o.group_name, o.label, o.price_amount == null ? null : Number(o.price_amount), o.stock == null ? null : Number(o.stock)]), [
                ['Size', 'S', null, null], ['Size', 'M', null, 0], ['Size', 'L', 2250, null],
            ]);
        });
        await check('a product without a fixed price gets no options (nothing could be bought at "Ask us")', async () => {
            const g = await row('Gift card');
            assert.notStrictEqual(g.price_type, 'fixed');
            assert.strictEqual((await sql.unsafe(`SELECT 1 FROM product_options WHERE product_id = ${g.id}`)).length, 0);
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
