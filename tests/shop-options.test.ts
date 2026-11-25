// tests/shop-options.test.ts
// Online shop Phase 1, product options (FR#35, docs/online-shop-review-plan.md §6): one group of choices
// per product, each with its own price and stock (src/utils/shop-options.ts); bought by option only, on
// the product's page; checkout charges the option's price and takes the option's stock; Shop tab and
// chat card save through one action.
//
// Run:  npx tsx tests/shop-options.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    allOptionsSoldOut, isMissingOptionsTable, loadProductOptions, optionItemName, optionPence, optionsWords, parseOptionsInput,
    saveProductOptions, takeOptionStock, MAX_OPTIONS, type ProductOptions,
} from '../src/utils/shop-options';
import { stockSnapshotLines } from '../src/utils/shop-snapshot';
import { classifySql } from '../src/utils/issue-sql';
import { normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage, renderSiteProduct } from '../src/utils/site-render';
import { checkoutParams, startCheckout, type SiteProduct } from '../src/utils/site-shop';
import { WORKSPACE_TABLES } from '../src/utils/workspace-export';
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

type Db = Parameters<typeof saveProductOptions>[0];
const sqlText = (q: unknown) => JSON.stringify((q as { queryChunks?: unknown })?.queryChunks ?? q);
const missingTable = Object.assign(new Error('relation "product_options" does not exist'), { code: '42P01' });

const SIZES: ProductOptions = { group: 'Size', options: [
    { id: 3, label: 'Small', priceAmount: 1000, stock: 4 },
    { id: 4, label: 'Large', priceAmount: null, stock: 0 },
] };
const BLEND: SiteProduct = { id: 11, name: 'House Blend', description: 'Our everyday coffee.', price: '£12.50', buyPence: 1250, imageAssetId: null, options: SIZES };
const site = (productIds: number[]): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee' },
    pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Fresh coffee' } }] },
        { title: 'Shop', slug: 'shop', sections: [{ type: 'products', props: { heading: 'Our coffee', productIds } }] },
    ],
}).definition;
const row: SiteRow = {
    id: 9, organisationId: 3, aiAssistantId: 4, createdBy: null, status: 'published', draft: {}, slug: 'willowbrook', credit: true,
    draftingAt: null, draftNote: null, createdAt: new Date(), updatedAt: new Date(), publishedVersion: 1, publishedAt: null,
    suspendedAt: null, suspendedReason: null,
};
const live = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };

async function main() {
    console.log('\nThe options');

    await check('a list is checked: names needed and unique, prices like 12.50 (or the product\'s), whole-number stock', () => {
        const ok = parseOptionsInput({ group: ' Size ', options: [{ label: 'Small', price: '10', stock: '4' }, { id: 4, label: 'Large', price: '', stock: '' }] });
        assert.deepStrictEqual(ok, { ok: true, value: { group: 'Size', options: [
            { id: null, label: 'Small', priceAmount: 1000, stock: 4 }, { id: 4, label: 'Large', priceAmount: null, stock: null },
        ] } });
        assert.deepStrictEqual(parseOptionsInput({ options: [] }), { ok: true, value: { group: 'Option', options: [] } }, 'empty = remove them');
        assert.strictEqual((parseOptionsInput({ options: [{ label: 'A', price: '£12.50' }] }) as { ok: true; value: { options: { priceAmount: number }[] } }).value.options[0].priceAmount, 1250);
        for (const bad of [
            { options: [{ label: '' }] }, { options: [{ label: 'A' }, { label: 'a' }] }, { options: [{ label: 'A', price: 'ten' }] },
            { options: [{ label: 'A', price: '0.10' }] }, { options: [{ label: 'A', stock: -1 }] }, { options: 'Small' },
            { options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ label: `O${i}` })) }, { group: 'x'.repeat(41), options: [] },
        ]) assert.strictEqual(parseOptionsInput(bad).ok, false, JSON.stringify(bad).slice(0, 60));
    });

    await check('an option charges its own price, else the product\'s; never when the product can\'t be bought online', () => {
        assert.strictEqual(optionPence(1250, { priceAmount: null }), 1250);
        assert.strictEqual(optionPence(1250, { priceAmount: 1000 }), 1000);
        assert.strictEqual(optionPence(null, { priceAmount: 1000 }), null);
        assert.strictEqual(optionItemName('House Blend', 'Large'), 'House Blend — Large');
        assert.ok(allOptionsSoldOut([{ stock: 0 }, { stock: 0 }]) && !allOptionsSoldOut([{ stock: 0 }, { stock: null }]) && !allOptionsSoldOut([]));
    });

    console.log('\nThe site');

    await check('a card with options links to the product page to choose (no Buy form); all sold out → Sold out', () => {
        const d = site([11]);
        const html = renderSitePage(d, '/shop', { ...live, canSell: true, products: { 11: BLEND } }).html;
        assert.ok(html.includes('data-choose-option') && html.includes('Choose size') && html.includes('href="/shop/11-house-blend"'));
        assert.ok(!html.includes('name="_pid"'), 'never bought from the card');
        const gone = renderSitePage(d, '/shop', { ...live, canSell: true, products: { 11: { ...BLEND, options: { group: 'Size', options: SIZES.options.map((o) => ({ ...o, stock: 0 })) } } } }).html;
        assert.ok(gone.includes('data-sold-out') && !gone.includes('data-choose-option'));
    });

    await check('the product page: each option with its own price and Buy button; a sold-out option says so', () => {
        const html = renderSiteProduct(site([11]), { ...live, canSell: true }, BLEND)!;
        assert.ok(html.includes('<h2>Size</h2>'));
        assert.ok(html.includes('<strong>Small</strong> · £10') && html.includes('name="_o" value="3"') && html.includes('name="_v" value="1000"'));
        assert.ok(html.includes('<strong>Large</strong> · £12.50') && !html.includes('name="_o" value="4"'), 'sold-out Large has no form');
        assert.ok(html.includes('data-option="4"><span><strong>Large</strong> · £12.50</span><span data-sold-out>'));
        assert.ok(html.includes('/delivery-returns'));
        assert.ok(html.includes('"name":"Small"') && html.includes('"price":"10.00"'), 'one Offer per option');
        const notSelling = renderSiteProduct(site([11]), { ...live, canSell: false }, BLEND)!;
        assert.ok(notSelling.includes('<strong>Small</strong> · £10') && !notSelling.includes('name="_o"') && !notSelling.includes('/delivery-returns'));
    });

    console.log('\nCheckout');

    const shopDb = (options: unknown[]) => ({
        select: () => ({ from: () => ({ where: async () => [{ id: 11, name: 'House Blend', description: null, price: '£12.50', priceType: 'fixed', priceAmount: 1250, imageAssetId: null }] }) }),
        execute: async (q: unknown) => (sqlText(q).includes('product_options') ? options : []),
    }) as unknown as Parameters<typeof startCheckout>[0];
    const optRows = [
        { id: 3, product_id: 11, group_name: 'Size', label: 'Small', price_amount: 1000, stock: 4 },
        { id: 4, product_id: 11, group_name: 'Size', label: 'Large', price_amount: null, stock: 0 },
    ];
    const go = (form: Record<string, string>) => {
        const d = site([11]);
        return startCheckout(shopDb(optRows), { site: row, definition: d, origin: live.origin, ip: '1.1.1.1', backPath: '/shop/11-house-blend', body: new URLSearchParams({ _s: d.pages[1].sections[0].id, _pid: '11', _n: 'House Blend', ...form }) });
    };

    await check('a product with options can\'t be bought without one: sent to its page to choose', async () => {
        const r = await go({ _v: '1250' });
        assert.ok(r.kind === 'error' && r.status === 409 && r.title === 'Choose an option' && r.backPath === '/shop/11-house-blend', JSON.stringify(r));
        const other = await go({ _o: '99', _v: '1000' });
        assert.ok(other.kind === 'error' && other.title === 'Choose an option', 'another product\'s option id');
    });

    await check('the option\'s price is checked, and a sold-out option is refused before Stripe', async () => {
        const wrongPrice = await go({ _o: '3', _v: '1250' });
        assert.ok(wrongPrice.kind === 'error' && wrongPrice.status === 409 && /changed/.test(wrongPrice.title), 'Small costs 1000, not the product\'s 1250');
        const sold = await go({ _o: '4', _v: '1250' });
        assert.ok(sold.kind === 'error' && sold.title === 'Sold out');
    });

    await check('the checkout names "Product — Option", charges its price, caps at its stock and records the option', () => {
        const p = checkoutParams({ origin: live.origin, site: row, sectionId: 's1', product: { ...BLEND, name: 'House Blend — Small', buyPence: 1000, stock: 4, options: null }, collectAddress: true, backPath: '/shop/11-house-blend', optionId: 3 });
        const line = p.line_items![0];
        assert.strictEqual(line.price_data!.product_data!.name, 'House Blend — Small');
        assert.strictEqual(line.price_data!.unit_amount, 1000);
        assert.strictEqual(line.adjustable_quantity!.maximum, 4);
        assert.strictEqual(p.metadata!.bms_option, '3');
        assert.strictEqual(p.metadata!.bms_item_name, 'House Blend — Small');
        assert.strictEqual(checkoutParams({ origin: live.origin, site: row, sectionId: 's1', product: { ...BLEND, options: null }, collectAddress: true, backPath: '/shop' }).metadata!.bms_option, undefined);
    });

    await check('a paid option takes ITS stock (once, after the order insert)', async () => {
        const src = read('src/utils/site-shop.ts');
        const insertDone = src.indexOf('if (!order) return true;   // a retry of an order already recorded');
        const take = src.indexOf('await takeOptionStock(db, site.organisationId, optionId, order.quantity)');
        assert.ok(insertDone > 0 && take > insertDone);
        assert.deepStrictEqual(await takeOptionStock({ execute: async () => [{ before: 4, after: 2 }] } as unknown as Db, 3, 3, 2), { before: 4, after: 2, lowStockAt: null, oversold: false });
        assert.strictEqual(await takeOptionStock({ execute: async () => { throw missingTable; } } as unknown as Db, 3, 3, 1), null);
        assert.strictEqual(await takeOptionStock({ execute: async () => [] } as unknown as Db, 3, 3, 1), null, 'not tracked');
    });

    console.log('\nReading and saving');

    await check('no table yet → no options, and a save says it isn\'t switched on', async () => {
        assert.ok(isMissingOptionsTable(missingTable) && !isMissingOptionsTable(new Error('timeout')));
        assert.deepStrictEqual(await loadProductOptions({ execute: async () => { throw missingTable; } } as unknown as Db, 3, [11]), {});
        const db = { execute: async () => [{ price_currency: 'GBP' }], transaction: async () => { throw missingTable; } } as unknown as Db;
        const r = await saveProductOptions(db, 3, 11, { group: 'Size', options: [{ label: 'Small' }] });
        assert.ok(!r.ok && r.status === 503);
    });

    await check('a save: 404 for another workspace\'s product, 400 for a bad list, then updates/inserts and archives the rest', async () => {
        const none = await saveProductOptions({ execute: async () => [] } as unknown as Db, 3, 11, { options: [] });
        assert.ok(!none.ok && none.status === 404);
        const bad = await saveProductOptions({ execute: async () => [{ price_currency: 'GBP' }] } as unknown as Db, 3, 11, { options: [{ label: '' }] });
        assert.ok(!bad.ok && bad.status === 400);
        const seen: string[] = [];
        const tx = { execute: async (q: unknown) => { const t = sqlText(q); seen.push(t); return /UPDATE product_options SET group_name/.test(t) ? [{ id: 4 }] : /INSERT INTO product_options/.test(t) ? [{ id: 7 }] : []; } };
        const db = {
            execute: async (q: unknown) => (sqlText(q).includes('FROM org_products') ? [{ price_currency: 'GBP' }] : [{ id: 4, product_id: 11, group_name: 'Size', label: 'Large', price_amount: null, stock: 2 }, { id: 7, product_id: 11, group_name: 'Size', label: 'Small', price_amount: 1000, stock: null }]),
            transaction: async (fn: (t: unknown) => Promise<void>) => fn(tx),
        } as unknown as Db;
        const ok = await saveProductOptions(db, 3, 11, { group: 'Size', options: [{ id: 4, label: 'Large', stock: 2 }, { label: 'Small', price: '10' }] });
        assert.ok(ok.ok && ok.value.options.length === 2);
        assert.ok(seen.some((t) => t.includes("status = 'archived'")), 'options left out are archived, never deleted');
        assert.ok(!seen.some((t) => /DELETE/i.test(t)));
    });

    console.log('\nShop tab, chat, export and SQL');

    await check('the chat sees each product\'s options with their ids, prices and stock', () => {
        assert.strictEqual(optionsWords(SIZES, 1250, 'GBP'), 'Size: Small [optionId 3] (£10, 4 left) · Large [optionId 4] (£12.50, sold out)');
        const lines = stockSnapshotLines({ ready: true, items: [{ id: 11, name: 'House Blend', price: '£12.50', pence: 1250, currency: 'GBP', stock: null, lowStockAt: null, state: 'untracked' }] }, { 11: SIZES }).join('\n');
        assert.ok(lines.includes('productId 11: House Blend (£12.50) — OPTIONS (stock is per option; product_stock does not apply): Size: Small [optionId 3]'));
    });

    await check('one server action for the Shop tab editor and the chat card', () => {
        const fn = read('netlify/functions/shop.ts');
        assert.ok(fn.includes("if (action === 'product_options')") && fn.includes('saveProductOptions(db, orgId, Number(body.productId), { group: body.group, options: body.options })'));
        const tab = read('src/components/assistant-shop.js');
        assert.ok(tab.includes("action: 'product_options', productId: Number(optSave.dataset.optSave)") && tab.includes('${optionsEditor(it, po)}'));
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("register('product_options', renderProductOptionsCard);") && reg.includes("new CustomEvent('shop:productOptions'"));
        const chat = read('src/components/chat-session.js');
        assert.ok(chat.includes("container.addEventListener('shop:productOptions', onProductOptions);") && chat.includes("container.removeEventListener('shop:productOptions', onProductOptions);"));
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('{"type":"product_options","productId":<from the STOCK list>'));
        assert.ok(read('src/config/chat-capabilities.generated.ts').includes('"product_options"'));
    });

    await check('exported with the workspace; the SQL is additive', () => {
        assert.ok('productOptions' in WORKSPACE_TABLES);
        assert.ok(read('db/schema.ts').includes('export const productOptions = pgTable("product_options"'));
        const q = read('db/z-shop-options.sql');
        assert.ok(q.includes('CREATE TABLE IF NOT EXISTS product_options') && q.includes('REFERENCES org_products(id) ON DELETE CASCADE'));
        assert.strictEqual(classifySql(q).safety, 'additive');
    });

    console.log(`\n${passed}/${total} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
