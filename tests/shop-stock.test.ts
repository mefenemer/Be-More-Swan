// tests/shop-stock.test.ts
// Online shop Phase 1, stock (FR#35, docs/online-shop-review-plan.md §6): how many of a product are
// left (src/utils/shop-stock.ts), "Sold out" on the site, checkout never selling more than are left,
// stock taken once when an order is paid, and the Shop tab + chat card saving through one action.
//
// Run:  npx tsx tests/shop-stock.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    isMissingStockColumn, loadStockLevels, STOCK_NOT_UPDATED_LINE, maxBuyable, parseStockInput, saveProductStock, stockAfterOrderLine, stockState, stockWords, takeStock, STOCK_MAX,
} from '../src/utils/shop-stock';
import { stockSnapshotLines } from '../src/utils/shop-snapshot';
import { classifySql } from '../src/utils/issue-sql';
import { normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { checkoutParams, MAX_QUANTITY, startCheckout, type SiteProduct } from '../src/utils/site-shop';
import type { SiteRow } from '../src/utils/site-store';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

type Db = Parameters<typeof takeStock>[0];
/** A database whose raw SQL (db.execute) answers with these rows, or throws this error. */
const execDb = (answer: unknown[] | Error, extra: Record<string, unknown> = {}) => ({
    execute: async () => { if (answer instanceof Error) throw answer; return answer; },
    ...extra,
}) as unknown as Db;
const missingColumn = Object.assign(new Error('column "stock" does not exist'), { code: '42703' });

const shop = (productIds: number[]): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee' },
    pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Fresh coffee' } }] },
        { title: 'Shop', slug: 'shop', sections: [{ type: 'products', props: { heading: 'Our coffee', productIds } }] },
    ],
}).definition;
const BLEND: SiteProduct = { id: 11, name: 'House Blend', description: 'Our everyday coffee.', price: '£12.50', buyPence: 1250, imageAssetId: null };
const row: SiteRow = {
    id: 9, organisationId: 3, aiAssistantId: 4, createdBy: null, status: 'published', draft: {}, slug: 'willowbrook', credit: true,
    draftingAt: null, draftNote: null, createdAt: new Date(), updatedAt: new Date(), publishedVersion: 1, publishedAt: null,
    suspendedAt: null, suspendedReason: null,
};
const live = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };

async function main() {
    console.log('\nStock levels');

    await check('state: empty = not tracked, 0 = sold out, at or below the warning = low', () => {
        assert.strictEqual(stockState(null), 'untracked');
        assert.strictEqual(stockState(undefined, 3), 'untracked');
        assert.strictEqual(stockState(0, 3), 'sold_out');
        assert.strictEqual(stockState(3, 3), 'low');
        assert.strictEqual(stockState(4, 3), 'in_stock');
        assert.strictEqual(stockState(1, null), 'in_stock');
    });

    await check('a buyer can pick at most what is left, never more than the cap', () => {
        assert.strictEqual(maxBuyable(null, MAX_QUANTITY), MAX_QUANTITY);
        assert.strictEqual(maxBuyable(3, MAX_QUANTITY), 3);
        assert.strictEqual(maxBuyable(500, MAX_QUANTITY), MAX_QUANTITY);
        assert.strictEqual(maxBuyable(0, MAX_QUANTITY), 0);
    });

    await check('the owner\'s words for each state', () => {
        assert.strictEqual(stockWords({ stock: null, lowStockAt: null }), 'Not tracked');
        assert.strictEqual(stockWords({ stock: 0, lowStockAt: 2 }), 'Sold out');
        assert.strictEqual(stockWords({ stock: 2, lowStockAt: 3 }), 'Low: 2 left (low at 3)');
        assert.strictEqual(stockWords({ stock: 12, lowStockAt: null }), '12 in stock');
    });

    await check('a save: whole numbers 0–100,000; empty clears; an absent key is left alone', () => {
        assert.deepStrictEqual(parseStockInput({ stock: '12' }), { ok: true, value: { stock: 12 } });
        assert.deepStrictEqual(parseStockInput({ stock: '', lowStockAt: 3 }), { ok: true, value: { stock: null, lowStockAt: 3 } });
        assert.deepStrictEqual(parseStockInput({ lowStockAt: null }), { ok: true, value: { lowStockAt: null } });
        for (const bad of [-1, 2.5, 'ten', STOCK_MAX + 1, '1e3']) assert.strictEqual(parseStockInput({ stock: bad }).ok, false, String(bad));
        assert.strictEqual(parseStockInput({}).ok, false, 'nothing to change');
    });

    console.log('\nThe site and checkout');

    await check('stock 0: "Sold out" instead of a Buy button (live and preview); stock left: the Buy button stays', () => {
        const d = shop([11]);
        const sold = renderSitePage(d, '/shop', { ...live, canSell: true, products: { 11: { ...BLEND, stock: 0 } } }).html;
        assert.ok(sold.includes('data-sold-out') && sold.includes('Sold out'));
        assert.ok(!sold.includes('name="_pid"'), 'no Buy form for a sold-out product');
        assert.ok(sold.includes('https://schema.org/OutOfStock'));
        const preview = renderSitePage(d, '/shop', { ...live, preview: true, canSell: true, products: { 11: { ...BLEND, stock: 0 } } }).html;
        assert.ok(preview.includes('data-sold-out'));
        const some = renderSitePage(d, '/shop', { ...live, canSell: true, products: { 11: { ...BLEND, stock: 4 } } }).html;
        assert.ok(some.includes('name="_pid"') && !some.includes('data-sold-out') && some.includes('https://schema.org/InStock'));
        const untracked = renderSitePage(d, '/shop', { ...live, canSell: true, products: { 11: BLEND } }).html;
        assert.ok(untracked.includes('name="_pid"') && !untracked.includes('schema.org/InStock'), 'not tracked: as before, no availability claim');
    });

    await check('checkout never offers more than are left; with one left the quantity is fixed at 1', () => {
        const at = (stock: number | null) => checkoutParams({ origin: live.origin, site: row, sectionId: 's1', product: { ...BLEND, stock }, collectAddress: true, backPath: '/shop' }).line_items![0];
        assert.deepStrictEqual(at(null).adjustable_quantity, { enabled: true, minimum: 1, maximum: MAX_QUANTITY });
        assert.deepStrictEqual(at(3).adjustable_quantity, { enabled: true, minimum: 1, maximum: 3 });
        assert.strictEqual(at(1).adjustable_quantity, undefined);
        assert.strictEqual(at(1).quantity, 1);
    });

    await check('a product that sold out since the page was drawn is refused before Stripe is called', async () => {
        const d = shop([11]);
        const sid = d.pages[1].sections[0].id;
        const db = {
            select: () => ({ from: () => ({ where: async () => [{ id: 11, name: 'House Blend', description: null, price: '£12.50', priceType: 'fixed', priceAmount: 1250, imageAssetId: null }] }) }),
            execute: async () => [{ id: 11, stock: 0, low_stock_at: null }],
        } as unknown as Parameters<typeof startCheckout>[0];
        const r = await startCheckout(db, { site: row, definition: d, origin: live.origin, ip: '1.1.1.1', backPath: '/shop', body: new URLSearchParams({ _s: sid, _pid: '11', _n: 'House Blend', _v: '1250' }) });
        assert.ok(r.kind === 'error' && r.status === 409 && r.title === 'Sold out', JSON.stringify(r));
    });

    console.log('\nReading and writing');

    await check('a database without the stock columns reads as "nothing tracked" and never throws', async () => {
        assert.ok(isMissingStockColumn(missingColumn));
        assert.ok(isMissingStockColumn({ cause: { code: '42703' } }));
        assert.ok(!isMissingStockColumn(new Error('connection reset')));
        assert.deepStrictEqual(await loadStockLevels(execDb(missingColumn), 3, [11]), {});
        assert.deepStrictEqual(await loadStockLevels(execDb([{ id: 11, stock: '5', low_stock_at: null }]), 3, [11]), { 11: { stock: 5, lowStockAt: null } });
        assert.strictEqual(await takeStock(execDb(missingColumn), 3, 11, 1), null);
        const save = await saveProductStock(execDb(missingColumn), 3, 11, { stock: 4 });
        assert.ok(!save.ok && save.status === 503);
    });

    await check('a save checks the input before touching the database, and 404s another workspace\'s product', async () => {
        const noDb = null as unknown as Db;
        const bad = await saveProductStock(noDb, 3, 11, { stock: -2 });
        assert.ok(!bad.ok && bad.status === 400);
        const noId = await saveProductStock(noDb, 3, 0, { stock: 2 });
        assert.ok(!noId.ok && noId.status === 400);
        const none = await saveProductStock(execDb([]), 3, 11, { stock: 2 });
        assert.ok(!none.ok && none.status === 404);
        const ok = await saveProductStock(execDb([{ id: 11, name: 'House Blend', stock: 2, low_stock_at: 1 }]), 3, 11, { stock: 2 });
        assert.ok(ok.ok && ok.item.stock === 2 && ok.item.lowStockAt === 1);
    });

    await check('stock taken for a paid order: counts down, stops at 0, and says when it was oversold', async () => {
        assert.deepStrictEqual(await takeStock(execDb([{ before: 5, after: 3, low_stock_at: null }]), 3, 11, 2), { before: 5, after: 3, lowStockAt: null, oversold: false });
        assert.deepStrictEqual(await takeStock(execDb([{ before: 1, after: 0, low_stock_at: null }]), 3, 11, 2), { before: 1, after: 0, lowStockAt: null, oversold: true });
        assert.strictEqual(await takeStock(execDb([]), 3, 11, 1), null, 'not tracked: nothing to take');
        assert.strictEqual(await takeStock(null as unknown as Db, 3, NaN, 1), null, 'no product id on the order');
    });

    await check('the owner\'s order email says what is left', () => {
        assert.strictEqual(stockAfterOrderLine(null, 1), null);
        assert.match(stockAfterOrderLine({ before: 5, after: 3, lowStockAt: null, oversold: false }, 2)!, /^3 left in stock/);
        assert.match(stockAfterOrderLine({ before: 4, after: 2, lowStockAt: 2, oversold: false }, 2)!, /Stock is low: 2 left/);
        assert.match(stockAfterOrderLine({ before: 1, after: 0, lowStockAt: null, oversold: false }, 1)!, /last one.*Sold out/);
        assert.match(stockAfterOrderLine({ before: 1, after: 0, lowStockAt: null, oversold: true }, 3)!, /Only 1 was in stock and 3 were paid for/);
    });

    await check('stock is taken only after the order row is new (a repeated webhook never takes it twice)', () => {
        const src = read('src/utils/site-shop.ts');
        const insertDone = src.indexOf('if (!order) return true;   // a retry of an order already recorded');
        const take = src.indexOf(': await takeStock(db, site.organisationId, productId, qty);');
        assert.ok(insertDone > 0 && take > insertDone, 'takeStock runs after the retry check');
        assert.ok(src.includes('<p><strong>Stock:</strong> ${esc(stockLine)}</p>'), 'the line reaches the owner\'s email');
        assert.ok(src.includes('for (let attempt = 1; attempt <= 2; attempt++)') && src.includes('stockLine = r.failed ? STOCK_NOT_UPDATED_LINE : stockAfterOrderLine(r.taken, order.quantity);'), 'a failed update is retried once, then the owner is told');
        assert.match(STOCK_NOT_UPDATED_LINE, /couldn't update the stock/);
    });

    console.log('\nShop tab, chat and SQL');

    await check('the chat sees each product\'s stock with the productId its card needs', () => {
        const lines = stockSnapshotLines({ ready: true, items: [{ id: 11, name: 'House Blend', price: '£12.50', stock: 0, lowStockAt: null, state: 'sold_out' }] }).join('\n');
        assert.ok(lines.includes('productId 11: House Blend (£12.50) — Sold out'));
        assert.match(stockSnapshotLines({ ready: false, items: [] }).join('\n'), /not switched on yet/);
        assert.match(stockSnapshotLines({ ready: true, items: [] }).join('\n'), /fixed price/);
        assert.deepStrictEqual(stockSnapshotLines(undefined), []);
    });

    await check('one server action for the Shop tab and the chat card', () => {
        const fn = read('netlify/functions/shop.ts');
        assert.ok(fn.includes("if (action === 'product_stock')") && fn.includes('saveProductStock(db, orgId, Number(body.productId)'));
        assert.ok(fn.includes('loadStockList(db, orgId)'), 'the tab gets the stock list');
        const tab = read('src/components/assistant-shop.js');
        assert.ok(tab.includes("action: 'product_stock', productId: Number(stockSave.dataset.stockSave)") && tab.includes('${stockCard(state.data)}'));
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("register('product_stock', renderProductStockCard);") && reg.includes("new CustomEvent('shop:productStock'"));
        const chat = read('src/components/chat-session.js');
        assert.ok(chat.includes("container.addEventListener('shop:productStock', onProductStock);") && chat.includes("action: 'product_stock', assistantId"));
        assert.ok(chat.includes("container.removeEventListener('shop:productStock', onProductStock);"));
    });

    await check('the Shopkeeper\'s prompt offers the card and no longer says stock is coming', () => {
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('{"type":"product_stock","productId":<its productId from the list>'));
        assert.ok(!orch.includes('add stock levels, delivery rates or a basket'), 'stock is no longer listed as coming');
        assert.ok(read('src/utils/assistant-chat-capabilities.ts').includes("product_stock: 'Set how many of a product are in stock"));
        assert.ok(read('src/config/chat-capabilities.generated.ts').includes('"product_stock"'));
    });

    await check('SQL: additive columns with a range check; kept out of db/schema.ts on purpose', () => {
        const q = read('db/z-shop-stock.sql');
        assert.ok(q.includes('ADD COLUMN IF NOT EXISTS stock        INTEGER CHECK (stock IS NULL OR stock BETWEEN 0 AND 100000)'));
        assert.ok(q.includes('ADD COLUMN IF NOT EXISTS low_stock_at INTEGER CHECK (low_stock_at IS NULL OR low_stock_at BETWEEN 0 AND 100000)'));
        assert.strictEqual(classifySql(q).safety, 'additive', 'the pipeline can run it');
        assert.ok(!/DROP|DELETE|TRUNCATE/i.test(q.replace(/--.*$/gm, '')), 'additive only');
        assert.ok(!read('db/schema.ts').includes('low_stock_at'), 'not in the Drizzle schema (select() would break before the SQL runs)');
    });

    console.log(`\n${passed}/${total} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
