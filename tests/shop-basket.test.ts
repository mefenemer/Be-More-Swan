// tests/shop-basket.test.ts
// Online shop Phase 1, basket (FR#35, docs/online-shop-review-plan.md §6): Shopkeeper workspaces get
// "Add to basket"; the basket is carried as ?b=<id>; every line is priced again from Business Information;
// one Stripe Checkout for the lot; the paid order gets its lines and each line's stock is taken.
//
// Run:  npx tsx tests/shop-basket.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    addItem, basketCount, basketOnCached, basketTotal, checkoutBlocker, checkoutLinesFor, cleanItems, isBasketId, newBasketId, orderSummaryName,
    priceBasket, setQty, withBasket, BASKET_LINE_MAX_QTY, BASKET_MAX_LINES, type BasketItem,
} from '../src/utils/shop-basket';
import { classifySql } from '../src/utils/issue-sql';
import { normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { renderSiteBasket, renderSitePage, renderSiteProduct } from '../src/utils/site-render';
import { getTableName } from 'drizzle-orm';
import { basketCheckoutParams, buyerEmail, recordPaidCheckout, startCheckout, ORDER_LINES_NOT_SAVED_LINE, type SiteProduct } from '../src/utils/site-shop';
import { EMPTY_SHOP_SETTINGS } from '../src/utils/shop-settings';
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
const sqlText = (q: unknown) => JSON.stringify((q as { queryChunks?: unknown })?.queryChunks ?? q);

const site = (productIds: number[]): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee' },
    pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Fresh coffee' } }] },
        { title: 'Shop', slug: 'shop', sections: [{ type: 'products', props: { heading: 'Our coffee', productIds } }] },
    ],
}).definition;
const DEF = site([11, 12, 13]);
const SID = DEF.pages[1].sections[0].id;
const BLEND: SiteProduct = { id: 11, name: 'House Blend', description: null, price: '£12.50', buyPence: 1250, imageAssetId: null, stock: 5 };
const MUG: SiteProduct = { id: 12, name: 'Mug', description: null, price: '£9', buyPence: 900, imageAssetId: null, stock: 0 };
const TEE: SiteProduct = { id: 13, name: 'T-shirt', description: null, price: '£20', buyPence: 2000, imageAssetId: null, options: { group: 'Size', options: [{ id: 3, label: 'Small', priceAmount: null, stock: 1 }, { id: 4, label: 'Large', priceAmount: 2200, stock: null }] } };
const PRODUCTS = { 11: BLEND, 12: MUG, 13: TEE };
const row: SiteRow = {
    id: 9, organisationId: 3, aiAssistantId: 4, createdBy: null, status: 'published', draft: {}, slug: 'willowbrook', credit: true,
    draftingAt: null, draftNote: null, createdAt: new Date(), updatedAt: new Date(), publishedVersion: 1, publishedAt: null,
    suspendedAt: null, suspendedReason: null,
};
const live = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };
const ID = 'AbCdEfGhIjKlMnOpQrStUvWx';

async function main() {
    console.log('\nThe basket itself');

    await check('ids are 24 random url-safe characters; links keep the basket', () => {
        const a = newBasketId();
        assert.ok(isBasketId(a) && a !== newBasketId());
        assert.ok(!isBasketId('short') && !isBasketId(`${ID}x`) && !isBasketId('AbCdEfGhIjKlMnOpQrStUv/x'));
        assert.strictEqual(withBasket('/shop', ID), `/shop?b=${ID}`);
        assert.strictEqual(withBasket('/shop?category=x#top', ID), `/shop?category=x&b=${ID}#top`);
    });

    await check('items: bad rows dropped, quantities capped; adding merges a line; 0 removes it; a full basket says so', () => {
        assert.deepStrictEqual(cleanItems([{ productId: 11, optionId: null, sectionId: 's', qty: 99 }, { productId: -1, sectionId: 's', qty: 1 }, 'x']), [{ productId: 11, optionId: null, sectionId: 's', qty: BASKET_LINE_MAX_QTY }]);
        let items: BasketItem[] = [];
        items = addItem(items, { productId: 11, optionId: null, sectionId: SID, qty: 1 }).items;
        items = addItem(items, { productId: 11, optionId: null, sectionId: SID, qty: 2 }).items;
        items = addItem(items, { productId: 13, optionId: 3, sectionId: SID, qty: 1 }).items;
        assert.deepStrictEqual(items.map((i) => [i.productId, i.optionId, i.qty]), [[11, null, 3], [13, 3, 1]]);
        assert.strictEqual(basketCount(items), 4);
        assert.deepStrictEqual(setQty(items, 0, 0).map((i) => i.productId), [13]);
        assert.strictEqual(setQty(items, 1, 7)[1].qty, 7);
        const full = Array.from({ length: BASKET_MAX_LINES }, (_, n) => ({ productId: n + 100, optionId: null, sectionId: SID, qty: 1 }));
        assert.match(addItem(full, { productId: 11, optionId: null, sectionId: SID, qty: 1 }).error!, /up to 20/);
    });

    await check('every line is priced from Business Information; gone items dropped; sold out / too many flagged', () => {
        const items: BasketItem[] = [
            { productId: 11, optionId: null, sectionId: SID, qty: 7 },     // only 5 left
            { productId: 12, optionId: null, sectionId: SID, qty: 1 },     // sold out
            { productId: 13, optionId: 4, sectionId: SID, qty: 2 },        // Large at its own price
            { productId: 13, optionId: 9, sectionId: SID, qty: 1 },        // option gone
            { productId: 11, optionId: null, sectionId: 'other', qty: 1 }, // section no longer offers it
        ];
        const { lines, dropped } = priceBasket(items, PRODUCTS, DEF);
        assert.deepStrictEqual(lines.map((l) => [l.name, l.unit, l.qty, l.max, l.problem]), [
            ['House Blend', 1250, 7, 5, 'Only 5 left'], ['Mug', 900, 1, 0, 'Sold out'], ['T-shirt — Large', 2200, 2, BASKET_LINE_MAX_QTY, null],
        ]);
        assert.strictEqual(dropped.length, 2);
        assert.match(checkoutBlocker(lines)!, /changed/);
        const ok = priceBasket([{ productId: 13, optionId: 4, sectionId: SID, qty: 2 }, { productId: 11, optionId: null, sectionId: SID, qty: 1 }], PRODUCTS, DEF).lines;
        assert.strictEqual(checkoutBlocker(ok), null);
        assert.strictEqual(basketTotal(ok), 2 * 2200 + 1250);
        assert.match(checkoutBlocker([])!, /empty/);
        assert.match(checkoutBlocker([{ ...ok[0], currency: 'GBP' }, { ...ok[1], currency: 'EUR' }])!, /different currencies/);
    });

    await check('the order\'s one-line name', () => {
        assert.strictEqual(orderSummaryName([{ name: 'House Blend', qty: 2 }]), 'House Blend × 2');
        assert.strictEqual(orderSummaryName([{ name: 'A', qty: 1 }, { name: 'B', qty: 1 }, { name: 'C', qty: 3 }, { name: 'D', qty: 1 }]), 'A, B + 2 more');
    });

    console.log('\nThe site');

    await check('a Shopkeeper workspace\'s cards say "Add to basket" and post _a=add (with the basket once it exists)', () => {
        const fresh = renderSitePage(DEF, '/shop', { ...live, canSell: true, products: { 11: BLEND }, basket: { on: true, id: null, count: 0 } }).html;
        assert.ok(fresh.includes('name="_a" value="add"') && fresh.includes('Add to basket') && !fresh.includes('name="_b"'));
        assert.ok(!fresh.includes('data-view-basket'));
        const carrying = renderSitePage(DEF, '/shop', { ...live, canSell: true, products: { 11: BLEND }, basket: { on: true, id: ID, count: 3 }, pagePath: (p) => withBasket(p, ID) }).html;
        assert.ok(carrying.includes(`name="_b" value="${ID}"`) && carrying.includes(`href="/basket?b=${ID}" data-view-basket>View basket (3)`));
        const plain = renderSitePage(DEF, '/shop', { ...live, canSell: true, products: { 11: BLEND } }).html;
        assert.ok(!plain.includes('name="_a"') && !plain.includes('Add to basket'), 'no Shopkeeper → the one-product Buy button');
        const preview = renderSitePage(DEF, '/shop', { ...live, preview: true, canSell: true, products: { 11: BLEND }, basket: { on: true, id: null, count: 0 } }).html;
        assert.ok(!preview.includes('Add to basket'));
    });

    await check('a product page with options adds the chosen option to the basket', () => {
        const html = renderSiteProduct(DEF, { ...live, canSell: true, basket: { on: true, id: ID, count: 1 } }, TEE)!;
        assert.ok(html.includes('name="_a" value="add"') && html.includes('name="_o" value="3"') && html.includes('Add to basket') && html.includes('View basket (1)'));
    });

    await check('the basket page: each line with quantity and Remove forms, the total, Check out; noindex', () => {
        const lines = priceBasket([{ productId: 13, optionId: 4, sectionId: SID, qty: 2 }, { productId: 11, optionId: null, sectionId: SID, qty: 1 }], PRODUCTS, DEF).lines;
        const html = renderSiteBasket(DEF, live, { id: ID, lines, dropped: [], canSell: true, continuePath: '/shop' });
        assert.ok(html.includes('<strong>T-shirt — Large</strong> · £22 each') && html.includes('£44'));
        assert.ok(html.includes('name="_a" value="set"') && html.includes('name="_a" value="remove"') && html.includes('name="_i" value="1"'));
        assert.ok(html.includes('Total: £56.50'));
        assert.ok(html.includes('name="_a" value="checkout"') && html.includes(`name="_b" value="${ID}"`));
        assert.ok(html.includes('noindex'));
        const sold = renderSiteBasket(DEF, live, { id: ID, lines: priceBasket([{ productId: 12, optionId: null, sectionId: SID, qty: 1 }], PRODUCTS, DEF).lines, dropped: ['Old thing is no longer for sale here'], canSell: true, continuePath: '/shop' });
        assert.ok(sold.includes('data-line-problem>Sold out') && sold.includes('data-basket-blocked') && !sold.includes('value="checkout"'));
        assert.ok(sold.includes('Old thing is no longer for sale here: taken out of your basket.'));
        const notSelling = renderSiteBasket(DEF, live, { id: ID, lines, dropped: [], canSell: false, continuePath: '/shop' });
        assert.ok(notSelling.includes('Online payments aren') && !notSelling.includes('value="checkout"'));
        const empty = renderSiteBasket(DEF, live, { id: null, lines: [], dropped: [], canSell: true, continuePath: '/shop' });
        assert.ok(empty.includes('Your basket is empty.') && empty.includes('Continue shopping'));
    });

    console.log('\nCheckout and the paid order');

    await check('one Stripe Checkout for the whole basket: each line at its Business Information price and quantity', () => {
        const lines = priceBasket([{ productId: 13, optionId: 4, sectionId: SID, qty: 2 }, { productId: 11, optionId: null, sectionId: SID, qty: 1 }], PRODUCTS, DEF).lines;
        const p = basketCheckoutParams({ origin: live.origin, site: row, basketId: ID, lines, collectAddress: true, shop: null });
        assert.deepStrictEqual(p.line_items!.map((l) => [l.price_data!.product_data!.name, l.price_data!.unit_amount, l.quantity, l.adjustable_quantity]), [
            ['T-shirt — Large', 2200, 2, undefined], ['House Blend', 1250, 1, undefined],
        ]);
        assert.strictEqual(p.metadata!.bms_basket, ID);
        assert.strictEqual(p.metadata!.bms_item_name, 'T-shirt — Large × 2, House Blend');
        assert.strictEqual(p.cancel_url, `${live.origin}/basket?b=${ID}`);
        assert.deepStrictEqual(p.shipping_address_collection, { allowed_countries: ['GB'] });
        assert.ok(!JSON.stringify(p).includes('application_fee'), '0% on sales');
    });

    await check('basket actions: off without a Shopkeeper; Add is checked like a Buy, then saved and sent to the basket page', async () => {
        const writes: string[] = [];
        const db = (on: boolean) => ({
            select: () => ({ from: () => ({ where: async () => [{ id: 11, name: 'House Blend', description: null, price: '£12.50', priceType: 'fixed', priceAmount: 1250, imageAssetId: null }] }) }),
            execute: async (q: unknown) => {
                const t = sqlText(q);
                if (t.includes('AS enabled')) return [{ enabled: on }];
                if (t.includes('INSERT INTO site_baskets')) { writes.push(t); return []; }
                return [];
            },
        }) as unknown as Parameters<typeof startCheckout>[0];
        const form = (extra: Record<string, string>) => new URLSearchParams({ _a: 'add', _s: SID, _pid: '11', _n: 'House Blend', _v: '1250', ...extra });
        const off = await startCheckout(db(false), { site: row, definition: DEF, origin: live.origin, ip: '1.1.1.1', backPath: '/shop', body: form({}) });
        assert.ok(off.kind === 'error' && off.status === 404 && /no basket/.test(off.title));
        const changed = await startCheckout(db(true), { site: row, definition: DEF, origin: live.origin, ip: '1.1.1.1', backPath: '/shop', body: form({ _v: '999' }) });
        assert.ok(changed.kind === 'error' && changed.status === 409, 'the price the visitor saw is checked on Add too');
        assert.strictEqual(writes.length, 0);
        const added = await startCheckout(db(true), { site: row, definition: DEF, origin: live.origin, ip: '1.1.1.1', backPath: '/shop', body: form({}) });
        assert.ok(added.kind === 'redirect' && /^\/basket\?b=[A-Za-z0-9_-]{24}$/.test(added.location), JSON.stringify(added));
        assert.strictEqual(writes.length, 1);
        const gone = await startCheckout(db(true), { site: row, definition: DEF, origin: live.origin, ip: '1.1.1.1', backPath: '/shop', body: new URLSearchParams({ _a: 'checkout', _b: ID }) });
        assert.ok(gone.kind === 'error' && /expired/.test(gone.title), 'no fresh basket of this site → expired');
    });

    await check('the webhook reads ONLY the lines saved for that session, and a later checkout never overwrites an earlier one', async () => {
        let asked = '';
        const db = { execute: async (q: unknown) => { asked = sqlText(q); return [{ lines: [{ productId: 11, optionId: null, name: 'House Blend', unit: 1250, qty: 2 }, { bad: true }] }]; } } as unknown as Parameters<typeof checkoutLinesFor>[0];
        const lines = await checkoutLinesFor(db, 3, ID, 'cs_test_1');
        assert.deepStrictEqual(lines, [{ productId: 11, optionId: null, name: 'House Blend', unit: 1250, qty: 2 }]);
        assert.ok(asked.includes('checkout_lines -> ') && asked.includes('organisation_id = '));
        assert.strictEqual(await checkoutLinesFor(db, 3, 'not-an-id', 'cs'), null);
        const src = read('src/utils/shop-basket.ts');
        assert.ok(src.includes('|| jsonb_build_object(${sessionId}::text, ${JSON.stringify(lines)}::jsonb)'), 'snapshots are kept per session');
        assert.ok(!/UPDATE site_baskets SET items = \$\{items\}::jsonb, checkout_lines = NULL/.test(src), 'changing the basket keeps the snapshots');
    });

    await check('a paid basket order writes its lines, takes each line\'s stock, empties the basket; both emails list the items', () => {
        const src = read('src/utils/site-shop.ts');
        const insertDone = src.indexOf('if (!order) return true;   // a retry of an order already recorded');
        const lines = src.indexOf('await writeOrderLines(db, order.id, site.organisationId, lines)');
        assert.ok(insertDone > 0 && lines > insertDone, 'after the insert (a repeated webhook writes nothing twice)');
        assert.ok(src.includes('const r = await takeOne(l.productId, l.optionId, l.qty);') && src.includes('await emptyBasket(db, basketId, site.organisationId)'));
        assert.ok(src.includes("${orderLines ? orderLinesHtml(orderLines, order.currency) : ''}"), 'owner email');
        const mail = buyerEmail({
            order: { id: 7, quantity: 3, itemName: 'T-shirt — Large × 2, House Blend', currency: 'gbp', customerName: 'Jo', shippingAddress: null } as never,
            shop: { ...EMPTY_SHOP_SETTINGS, traderName: 'Willowbrook', deliveryText: 'Royal Mail' }, total: '£56.50', termsUrl: null,
            lines: [{ name: 'T-shirt — Large', unit: 2200, qty: 2 }, { name: 'House Blend', unit: 1250, qty: 1 }],
        });
        assert.ok(mail.html.includes('<li>2 × T-shirt — Large — £44</li>') && mail.html.includes('<li>1 × House Blend — £12.50</li>') && mail.html.includes('reference 7'));
    });

    // The paid-basket webhook path, RUN against a stand-in database (review of #878). No email can be sent:
    // the stand-in owner has no email address and the buyer gave none.
    const webhookDb = (opts: { lines?: unknown; duplicate?: boolean; linesFail?: boolean } = {}) => {
        const log = { exec: [] as string[], orders: [] as Record<string, unknown>[] };
        const rowsFor = (t: string): unknown[] => (t === 'sites' ? [row] : t === 'stripe_connect_accounts' ? [{ stripeAccountId: 'acct_1', organisationId: 3, chargesEnabled: true }] : t === 'ai_assistants' ? [{ userId: null, name: 'Shop', email: null }] : []);
        const chain = (t: string) => { const c: Record<string, unknown> = {}; c.leftJoin = () => c; c.innerJoin = () => c; c.where = () => c; c.limit = async () => rowsFor(t); return c; };
        const db = {
            select: () => ({ from: (tbl: Parameters<typeof getTableName>[0]) => chain(getTableName(tbl)) }),
            insert: () => ({ values: (v: Record<string, unknown>) => ({ onConflictDoNothing: () => ({ returning: async () => { log.orders.push(v); return opts.duplicate ? [] : [{ id: 77, refundedAmount: 0, status: 'paid', createdAt: new Date(), ...v }]; } }) }) }),
            update: () => ({ set: () => ({ where: async () => [] }) }),
            execute: async (q: unknown) => {
                const t = sqlText(q);
                log.exec.push(t);
                if (t.includes('checkout_lines -> ')) return [{ lines: opts.lines === undefined ? [{ productId: 13, optionId: 4, name: 'T-shirt — Large', unit: 2200, qty: 2 }, { productId: 11, optionId: null, name: 'House Blend', unit: 1250, qty: 1 }] : opts.lines }];
                if (t.includes('INSERT INTO site_order_lines') && opts.linesFail) throw new Error('db down');
                if (t.includes('UPDATE product_options o SET stock')) return [{ before: 4, after: 2 }];
                if (t.includes('UPDATE org_products p SET stock')) return [{ before: 5, after: 4, low_stock_at: null }];
                return [];
            },
        } as unknown as Parameters<typeof recordPaidCheckout>[0];
        return { db, log };
    };
    const paid = { id: 'cs_test_1', payment_status: 'paid', amount_total: 5650, amount_subtotal: 5650, currency: 'gbp', customer_details: { name: 'Jo', email: null }, collected_information: null, payment_intent: 'pi_1',
        metadata: { bms_site_id: '9', bms_org_id: '3', bms_basket: ID, bms_item_name: 'T-shirt — Large × 2, House Blend', bms_page: '/basket' } } as never;

    await check('RUN: a paid basket records one order, all its lines in one statement, each line\'s stock, and empties the basket', async () => {
        const { db, log } = webhookDb();
        assert.strictEqual(await recordPaidCheckout(db, 'acct_1', paid), true);
        assert.strictEqual(log.orders.length, 1);
        assert.strictEqual(log.orders[0].quantity, 3, '2 + 1');
        assert.strictEqual(log.orders[0].itemName, 'T-shirt — Large × 2, House Blend');
        const inserts = log.exec.filter((t) => t.includes('INSERT INTO site_order_lines'));
        assert.strictEqual(inserts.length, 1, 'one statement for every line');
        assert.ok(inserts[0].includes('T-shirt — Large') && inserts[0].includes('House Blend'));
        assert.strictEqual(log.exec.filter((t) => t.includes('UPDATE product_options o SET stock')).length, 1, 'the Large option\'s stock');
        assert.strictEqual(log.exec.filter((t) => t.includes('UPDATE org_products p SET stock')).length, 1, 'House Blend\'s stock');
        assert.ok(log.exec.some((t) => t.includes("UPDATE site_baskets SET items = '[]'::jsonb")), 'the basket is emptied');
    });

    await check('RUN: a repeated webhook records nothing more (no lines, no stock, basket untouched)', async () => {
        const { db, log } = webhookDb({ duplicate: true });
        assert.strictEqual(await recordPaidCheckout(db, 'acct_1', paid), true);
        assert.ok(!log.exec.some((t) => /INSERT INTO site_order_lines|SET stock|UPDATE site_baskets/.test(t)));
    });

    await check('RUN: saved lines that can\'t be read → the order is still recorded, no stock is guessed', async () => {
        const { db, log } = webhookDb({ lines: null });
        assert.strictEqual(await recordPaidCheckout(db, 'acct_1', paid), true);
        assert.strictEqual(log.orders.length, 1);
        assert.ok(!log.exec.some((t) => /INSERT INTO site_order_lines|SET stock/.test(t)));
    });

    await check('RUN: lines that fail to save → stock is still taken and the owner\'s email says so', async () => {
        const { db, log } = webhookDb({ linesFail: true });
        assert.strictEqual(await recordPaidCheckout(db, 'acct_1', paid), true);
        assert.strictEqual(log.exec.filter((t) => /SET stock/.test(t)).length, 2);
        assert.ok(read('src/utils/site-shop.ts').includes('${linesFailed ? `<p><strong>⚠️ ${esc(ORDER_LINES_NOT_SAVED_LINE)}</strong></p>` : \'\'}'));
        assert.match(ORDER_LINES_NOT_SAVED_LINE, /couldn't save this order's items/);
    });

    await check('a refused Add keeps the basket in its Go back link; starting a basket is rate-limited', () => {
        const src = read('src/utils/site-shop.ts');
        assert.ok(src.includes("return basket && r.kind === 'error' ? { ...r, backPath: withBasket(r.backPath, basket.id) } : r;"));
        assert.ok(src.includes("await rateLimited(db, req.ip, back, 'site_basket_ip', NEW_BASKET_LIMIT)"));
    });

    console.log('\nServing, sweep, export and SQL');

    await check('site-serve: /basket never cached or indexed; a page carrying ?b= keeps it in links and is never shared-cached', () => {
        const serve = read('netlify/functions/site-serve.ts');
        assert.ok(serve.includes("if (path === BASKET_PATH && basketIsOn) {") && serve.includes("headers('text/html; charset=utf-8', 'private, no-store'), 'X-Robots-Tag': 'noindex'"));
        assert.ok(serve.includes("const pageCache = basket ? 'private, no-store' : 'public, max-age=60';"));
        assert.ok(serve.includes('pagePath: (p: string) => withBasket(p, basket.id)'));
        assert.ok(serve.includes('ctx: pageCtx,') && serve.includes('...pageCtx, forms:'));
        assert.ok(read('sites-host/edge-functions/serve.ts').includes("'/_buy'"), 'every basket action posts to /_buy, which the sites host allows');
    });

    await check('week-old baskets are swept daily; order lines are exported; the Mentor never reads either', () => {
        assert.ok(read('netlify/functions/purge-archived-assistants.ts').includes('await sweepBaskets(db)'));
        assert.ok('websiteOrderLines' in WORKSPACE_TABLES);
        const inv = read('src/config/mentor-data-inventory.ts');
        assert.ok(inv.includes("'site_order_lines', 'site_baskets'"));
    });

    await check('review #885: page views ask "basket on?" once a minute per workspace; checkout still asks fresh', async () => {
        let queries = 0;
        const fakeDb = { execute: async () => { queries++; return [{ enabled: true }]; } } as unknown as Parameters<typeof basketOnCached>[0];
        assert.strictEqual(await basketOnCached(fakeDb, 90001), true);
        assert.strictEqual(await basketOnCached(fakeDb, 90001), true);
        assert.strictEqual(queries, 1);
        assert.strictEqual(await basketOnCached(fakeDb, 90002), true);
        assert.strictEqual(queries, 2);
        // review #887: a failed read is not remembered.
        let fails = 0;
        const flaky = { execute: async () => { fails++; if (fails === 1) throw new Error('boom'); return [{ enabled: true }]; } } as unknown as Parameters<typeof basketOnCached>[0];
        const quiet = console.error; console.error = () => {};
        try { assert.strictEqual(await basketOnCached(flaky, 90003), false); } finally { console.error = quiet; }
        assert.strictEqual(await basketOnCached(flaky, 90003), true);
        assert.strictEqual(fails, 2);
        const serve = read('netlify/functions/site-serve.ts');
        assert.ok(serve.includes('hasProducts && await basketOnCached(db, site.organisationId)') && !serve.includes('basketOn('));
        assert.ok(read('src/utils/site-shop.ts').includes('if (!(await basketOn(db, orgId)))'));
        // …and the business-kind guess reads the website's draft, not a shop page's.
        assert.ok(read('src/utils/offer-profile.ts').includes('.where(eq(sites.organisationId, organisationId)).orderBy(websiteSiteFirst).limit(1)'));
    });

    await check('SQL: additive', () => {
        const q = read('db/z-shop-basket.sql');
        assert.ok(q.includes('CREATE TABLE IF NOT EXISTS site_baskets') && q.includes('CREATE TABLE IF NOT EXISTS site_order_lines'));
        assert.strictEqual(classifySql(q).safety, 'additive');
    });

    console.log(`\n${passed}/${total} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
