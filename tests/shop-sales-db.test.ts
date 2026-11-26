// tests/shop-sales-db.test.ts
// "Ask your shop" totals on REAL Postgres — src/utils/shop-sales.ts loadShopSales (online shop Phase 2, slice 1;
// feature request #35, docs/online-shop-review-plan.md §12).
//
// WHY A DATABASE TEST. The answers to "how much did I sell in October?" come from FILTER aggregates, UK-month
// buckets of UTC timestamps (AT TIME ZONE twice) and a UNION of basket lines with single Buy-button orders —
// only Postgres can prove those statements.
//
// HOW. Copies of site_orders, site_order_lines and org_products (`LIKE … INCLUDING DEFAULTS`: real columns, no
// foreign keys) in a throwaway schema, on ONE connection with search_path set to it. Timestamps are written
// relative to the database clock so the test never goes stale.
//
// ⚠️ Runs ONLY against a database on localhost (CI's rls job). db/client loads .env, and locally that is
// STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/shop-sales-db.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closeDbPools } from '../db/client';
import { loadShopSales, monthSummary, previousMonth, salesSnapshotLines } from '../src/utils/shop-sales';

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
    console.log('Ask your shop — sales totals, best sellers, waiting orders (real Postgres)');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `shop_sales_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        for (const t of ['site_orders', 'site_order_lines', 'org_products']) {
            await sql.unsafe(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS)`);
        }
        await sql.unsafe(`SET search_path TO ${schema}`);
        const db = drizzle({ client: sql }) as never;

        const ORG = 7, OTHER = 8;
        // UTC timestamp for "this UK month's start + offset" (offset may be negative → last month).
        const ukMonthStart = (offset: string) =>
            `((date_trunc('month', now() AT TIME ZONE 'Europe/London') + interval '${offset}') AT TIME ZONE 'Europe/London' AT TIME ZONE 'UTC')`;
        const order = async (o: { org?: number; at: string; item: string; qty?: number; total: number; currency?: string; status?: string; refunded?: number; buyer?: string }) => {
            const [r] = await sql.unsafe(
                `INSERT INTO site_orders (site_id, organisation_id, stripe_account_id, checkout_session_id, item_name, quantity, amount_total, currency, customer_name, status, refunded_amount, created_at)
                 VALUES (1, $1, 'acct_x', 'cs_' || md5(random()::text), $2, $3, $4, $5, $6, $7, $8, ${o.at}) RETURNING id`,
                [o.org ?? ORG, o.item, o.qty ?? 1, o.total, o.currency ?? 'gbp', o.buyer ?? null, o.status ?? 'paid', o.refunded ?? 0]);
            return Number(r.id);
        };
        const line = (orderId: number, productId: number | null, item: string, unit: number, qty: number) => sql.unsafe(
            `INSERT INTO site_order_lines (order_id, organisation_id, product_id, item_name, unit_amount, quantity) VALUES ($1, $2, $3, $4, $5, $6)`,
            [orderId, ORG, productId, item, unit, qty]);
        const [p] = await sql.unsafe(`INSERT INTO org_products (organisation_id, kind, name) VALUES (${ORG}, 'product', 'Fig candle') RETURNING id`);
        const fig = Number(p.id);

        // This UK month: a basket order (2 Fig candles under an older line name + 1 mug), a single Buy order,
        // a fully refunded order, a part-refunded one, a euro order, and one 30 minutes into the month.
        const basket = await order({ at: ukMonthStart('2 days'), item: 'Fig candle × 2, Mug', qty: 3, total: 3400, buyer: 'Sam', status: 'posted' });
        await line(basket, fig, 'Fig candle — Large', 1200, 2);
        await line(basket, null, 'Mug', 800, 1);
        await order({ at: ukMonthStart('3 days'), item: 'Fig candle', total: 1200, buyer: 'Jo' });
        await order({ at: ukMonthStart('4 days'), item: 'Tote bag', total: 900, status: 'refunded', refunded: 900 });
        await order({ at: ukMonthStart('5 days'), item: 'Mug', total: 800, refunded: 300, status: 'done' });
        await order({ at: ukMonthStart('6 days'), item: 'Mug', total: 1000, currency: 'eur', status: 'done' });
        await order({ at: ukMonthStart('30 minutes'), item: 'Fig candle', total: 1200, buyer: 'Early' });
        // 30 minutes BEFORE this UK month started → last month, even though in UTC it may be the same day.
        await order({ at: ukMonthStart('-30 minutes'), item: 'Mug', total: 800, buyer: 'Late', status: 'done' });
        // 13 months ago: outside the 12 months listed. Another workspace's order: never counted.
        await order({ at: ukMonthStart('-13 months'), item: 'Mug', total: 800, status: 'done' });
        // Two months ago: one order, refunded in full — the month is still listed (review #894).
        await order({ at: ukMonthStart('-1 month -5 days'), item: 'Mug', total: 800, status: 'refunded', refunded: 800 });
        await order({ org: OTHER, at: ukMonthStart('1 day'), item: 'Secret', total: 99900 });

        const s = await loadShopSales(db, ORG);
        const { thisMonth, lastMonth } = monthSummary(s);

        await check('this UK month: orders not refunded in full; sold after refunds; currencies kept apart', () => {
            assert.strictEqual(thisMonth.orders, 5);
            assert.strictEqual(thisMonth.refunded, 1);
            assert.deepStrictEqual(thisMonth.sold, { GBP: 3400 + 1200 + 0 + 500 + 1200, EUR: 1000 });
        });
        await check('an order 30 minutes before the UK month began is last month\'s; 13 months ago is not listed', () => {
            assert.strictEqual(lastMonth.month, previousMonth(s.thisMonth));
            assert.strictEqual(lastMonth.orders, 1);
            assert.deepStrictEqual(lastMonth.sold, { GBP: 800 });
            assert.strictEqual(s.months.length, 3);
            assert.deepStrictEqual(s.months[2], { month: previousMonth(previousMonth(s.thisMonth)), orders: 0, sold: { GBP: 0 }, refunded: 1 });
        });
        await check('best sellers by units: basket lines by the product\'s name today, Buy orders by their item name', () => {
            assert.deepStrictEqual(s.bestThisMonth.map((b) => [b.name, b.units]), [['Fig candle', 4], ['Mug', 3]]);
            assert.deepStrictEqual(s.bestThisMonth[0].sold, { GBP: 2400 + 1200 + 1200 });
            assert.deepStrictEqual(s.bestThisMonth[1].sold, { GBP: 800 + 500, EUR: 1000 });
            assert.ok(!s.bestThisMonth.some((b) => b.name === 'Tote bag' || b.name === 'Secret'));
        });
        await check('waiting = every paid order (not posted, done or refunded), oldest first, this workspace only', () => {
            assert.strictEqual(s.waitingCount, 2);
            assert.deepStrictEqual(s.waiting.map((w) => w.customerName), ['Early', 'Jo']);
            assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(s.waiting[0].date));
        });
        await check('the snapshot lines quote it', () => {
            const text = salesSnapshotLines(s).join('\n');
            assert.ok(text.includes('5 orders, £63 + €10 sold (1 more refunded in full)'), text);
            assert.ok(text.includes('1. Fig candle: 4 sold\n'), text);
            assert.ok(text.includes('WAITING TO BE POSTED (paid, not yet posted or dealt with): 2 orders'), text);
        });
        await check('no order-lines table: falls back to orders alone', async () => {
            await sql.unsafe(`ALTER TABLE site_order_lines RENAME TO site_order_lines_gone`);
            const s2 = await loadShopSales(db, ORG);
            await sql.unsafe(`ALTER TABLE site_order_lines_gone RENAME TO site_order_lines`);
            // The basket order now counts under its own one-line name.
            assert.ok(s2.bestThisMonth.some((b) => b.name === 'Fig candle × 2, Mug' && b.units === 3));
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
