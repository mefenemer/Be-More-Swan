// tests/shop-delivery.test.ts
// Online shop Phase 1, UK delivery rates (FR#35, docs/online-shop-review-plan.md §6): up to 5 choices buyers
// pick on Stripe's page at basket checkout, free over a threshold, collect in person (src/utils/shop-delivery.ts);
// the paid order records the choice; Shop tab and chat card save through one owner/admin action.
//
// Run:  npx tsx tests/shop-delivery.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import {
    deliveryOptionsFor, deliveryWords, hasDelivery, loadDelivery, parseDeliveryInput, saveDelivery, setupFromStored, stripeShippingOptions,
    MAX_DELIVERY_OPTIONS, type DeliverySetup,
} from '../src/utils/shop-delivery';
import { deliverySnapshotLines } from '../src/utils/shop-snapshot';
import { shopTermsHtml, EMPTY_SHOP_SETTINGS } from '../src/utils/shop-settings';
import { classifySql } from '../src/utils/issue-sql';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSiteBasket } from '../src/utils/site-render';
import { basketCheckoutParams, buyerEmail, deliveryLine, recordPaidCheckout } from '../src/utils/site-shop';
import { priceBasket } from '../src/utils/shop-basket';
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
type Db = Parameters<typeof loadDelivery>[0];
const missingColumn = Object.assign(new Error('column "delivery" does not exist'), { code: '42703' });

const SETUP: DeliverySetup = {
    rates: [
        { name: 'Royal Mail Tracked 48', price: 395, freeOver: 4000, days: '2–3 working days' },
        { name: 'Next day', price: 795, freeOver: null, days: null },
    ],
    collect: { on: true, note: '12 Mill Lane, Tue–Sat' },
};
const DEF = normaliseSiteDefinition({ settings: { siteName: 'Willowbrook' }, pages: [{ title: 'Shop', slug: 'shop', sections: [{ type: 'products', props: { productIds: [11] } }] }] }).definition;
const SID = DEF.pages[0].sections[0].id;
const row: SiteRow = {
    id: 9, organisationId: 3, aiAssistantId: 4, createdBy: null, status: 'published', draft: {}, slug: 'willowbrook', credit: true,
    draftingAt: null, draftNote: null, createdAt: new Date(), updatedAt: new Date(), publishedVersion: 1, publishedAt: null,
    suspendedAt: null, suspendedReason: null,
};
const origin = 'https://willowbrook.bemoreswan.site';
const ID = 'AbCdEfGhIjKlMnOpQrStUvWx';
const lines = (qty: number) => priceBasket([{ productId: 11, optionId: null, sectionId: SID, qty }], { 11: { id: 11, name: 'House Blend', description: null, price: '£12.50', buyPence: 1250, imageAssetId: null } }, DEF).lines;

async function main() {
    console.log('\nThe choices');

    await check('a set-up is checked: names, prices like 3.95 (0 = free), optional free-over and time, collect', () => {
        const r = parseDeliveryInput({ rates: [{ name: ' Royal Mail Tracked 48 ', price: '£3.95', freeOver: '40', days: '2–3 working days' }, { name: 'Next day', price: 7.95 }], collect: { on: true, note: '12 Mill Lane, Tue–Sat' } });
        assert.deepStrictEqual(r, { ok: true, value: SETUP });
        assert.deepStrictEqual(parseDeliveryInput({ rates: [{ name: 'Free', price: '0', freeOver: '20' }] }), { ok: true, value: { rates: [{ name: 'Free', price: 0, freeOver: null, days: null }], collect: { on: false, note: null } } }, 'free already: no threshold');
        assert.deepStrictEqual(parseDeliveryInput({}), { ok: true, value: { rates: [], collect: { on: false, note: null } } }, 'empty = no delivery choices');
        for (const bad of [
            { rates: [{ name: '', price: 1 }] }, { rates: [{ name: 'A', price: 'three' }] }, { rates: [{ name: 'A' }] }, { rates: [{ name: 'A', price: 1 }, { name: 'a', price: 2 }] },
            { rates: [{ name: 'A', price: '600' }] }, { rates: [{ name: 'A', price: 1, freeOver: 'lots' }] }, { rates: 'Royal Mail' },
            { rates: Array.from({ length: MAX_DELIVERY_OPTIONS }, (_, i) => ({ name: `R${i}`, price: 1 })), collect: { on: true } },
        ]) assert.strictEqual(parseDeliveryInput(bad as never).ok, false, JSON.stringify(bad).slice(0, 70));
    });

    await check('the choices for an order: a rate is free at or over its threshold; collect is free', () => {
        assert.deepStrictEqual(deliveryOptionsFor(SETUP, 3999).map((o) => [o.name, o.amount]), [['Royal Mail Tracked 48', 395], ['Next day', 795], ['Collect in person: 12 Mill Lane, Tue–Sat', 0]]);
        assert.deepStrictEqual(deliveryOptionsFor(SETUP, 4000).map((o) => [o.name, o.amount]), [['Royal Mail Tracked 48 (free over £40)', 0], ['Next day', 795], ['Collect in person: 12 Mill Lane, Tue–Sat', 0]]);
        assert.ok(!hasDelivery({ rates: [], collect: { on: false, note: null } }) && hasDelivery(SETUP));
    });

    await check('Stripe gets them cheapest first, in pounds, with the time beside the name and the choice in metadata', () => {
        const opts = stripeShippingOptions(deliveryOptionsFor(SETUP, 1000));
        assert.deepStrictEqual(opts.map((o) => [o.shipping_rate_data!.display_name, o.shipping_rate_data!.fixed_amount!.amount, o.shipping_rate_data!.fixed_amount!.currency]), [
            ['Collect in person: 12 Mill Lane, Tue–Sat', 0, 'gbp'], ['Royal Mail Tracked 48 · 2–3 working days', 395, 'gbp'], ['Next day', 795, 'gbp'],
        ]);
        assert.strictEqual(opts[1].shipping_rate_data!.metadata!.bms_delivery, 'Royal Mail Tracked 48');
    });

    await check('stored → read back is the same set-up (pence stored, pounds parsed)', () => {
        assert.deepStrictEqual(setupFromStored({ zones: { uk: SETUP } }), SETUP);
        assert.strictEqual(setupFromStored(null), null);
        assert.strictEqual(setupFromStored({ zones: { eu: SETUP } }), null, 'only the uk zone for now');
        assert.strictEqual(deliveryWords(SETUP), 'Royal Mail Tracked 48 £3.95 (free over £40), 2–3 working days · Next day £7.95 · Collect in person (12 Mill Lane, Tue–Sat)');
    });

    console.log('\nCheckout, pages and the paid order');

    await check('a basket checkout offers the choices (and asks for an address); with none, nothing changes', () => {
        const withRates = basketCheckoutParams({ origin, site: row, basketId: ID, lines: lines(4), collectAddress: false, delivery: SETUP });
        assert.strictEqual(withRates.shipping_options!.length, 3);
        assert.ok(withRates.shipping_options!.some((o) => o.shipping_rate_data!.display_name === 'Royal Mail Tracked 48 (free over £40) · 2–3 working days' && o.shipping_rate_data!.fixed_amount!.amount === 0), '4 × £12.50 = £50 ≥ £40');
        assert.deepStrictEqual(withRates.shipping_address_collection, { allowed_countries: ['GB'] });
        const none = basketCheckoutParams({ origin, site: row, basketId: ID, lines: lines(1), collectAddress: false, delivery: null });
        assert.strictEqual(none.shipping_options, undefined);
        assert.strictEqual(none.shipping_address_collection, undefined);
    });

    await check('buyers see the choices and costs before paying: basket page and Delivery & returns page', () => {
        const page = renderSiteBasket(DEF, { origin, preview: false, reportUrl: '#', creditUrl: null }, { id: ID, lines: lines(1), dropped: [], canSell: true, continuePath: '/shop', delivery: deliveryWords(SETUP) });
        assert.ok(page.includes('data-basket-delivery><strong>Delivery:</strong> Royal Mail Tracked 48 £3.95 (free over £40)'));
        const terms = shopTermsHtml({ ...EMPTY_SHOP_SETTINGS, traderName: 'W', contactEmail: 'a@b.c', deliveryText: 'Royal Mail' }, deliveryWords(SETUP));
        assert.ok(terms.includes('<strong>Delivery choices and costs:</strong> Royal Mail Tracked 48 £3.95'));
        assert.ok(!shopTermsHtml({ ...EMPTY_SHOP_SETTINGS, traderName: 'W', contactEmail: 'a@b.c', deliveryText: 'x' }).includes('Delivery choices and costs'));
    });

    await check('RUN: a paid basket order records the delivery chosen (name from the rate, cost from Stripe); emails say it', async () => {
        const exec: string[] = [];
        const rowsFor = (t: string): unknown[] => (t === 'sites' ? [row] : t === 'stripe_connect_accounts' ? [{ stripeAccountId: 'acct_1', organisationId: 3, chargesEnabled: true }] : t === 'ai_assistants' ? [{ userId: null, name: 'Shop', email: null }] : []);
        const chain = (t: string) => { const c: Record<string, unknown> = {}; c.leftJoin = () => c; c.where = () => c; c.limit = async () => rowsFor(t); return c; };
        const db = {
            select: () => ({ from: (tbl: Parameters<typeof getTableName>[0]) => chain(getTableName(tbl)) }),
            insert: () => ({ values: (v: Record<string, unknown>) => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 77, refundedAmount: 0, status: 'paid', createdAt: new Date(), ...v }] }) }) }),
            update: () => ({ set: () => ({ where: async () => [] }) }),
            execute: async (q: unknown) => { const t = sqlText(q); exec.push(t); return t.includes('checkout_lines -> ') ? [{ lines: [{ productId: 11, optionId: null, name: 'House Blend', unit: 1250, qty: 4 }] }] : []; },
        } as unknown as Parameters<typeof recordPaidCheckout>[0];
        const session = {
            id: 'cs_1', payment_status: 'paid', amount_total: 5000, amount_subtotal: 5000, currency: 'gbp', customer_details: { name: 'Jo', email: null }, collected_information: null, payment_intent: 'pi_1',
            shipping_cost: { amount_total: 0, shipping_rate: { id: 'shr_1', display_name: 'Royal Mail Tracked 48 (free over £40) · 2–3 working days', metadata: { bms_delivery: 'Royal Mail Tracked 48 (free over £40)' } } },
            metadata: { bms_site_id: '9', bms_org_id: '3', bms_basket: ID, bms_item_name: 'House Blend × 4', bms_page: '/basket' },
        } as never;
        assert.strictEqual(await recordPaidCheckout(db, 'acct_1', session), true);
        const saved = exec.find((t) => t.includes('UPDATE site_orders SET delivery_name'));
        assert.ok(saved && saved.includes('Royal Mail Tracked 48 (free over £40)'), 'the choice is recorded on the order');
        assert.strictEqual(deliveryLine({ name: 'Royal Mail Tracked 48', amount: 395 }, 'gbp'), 'Royal Mail Tracked 48 — £3.95');
        assert.strictEqual(deliveryLine({ name: 'Collect in person', amount: 0 }, 'gbp'), 'Collect in person — free');
        const mail = buyerEmail({ order: { id: 7, quantity: 4, itemName: 'House Blend × 4', currency: 'gbp', customerName: 'Jo', shippingAddress: null } as never, shop: { ...EMPTY_SHOP_SETTINGS, traderName: 'W', deliveryText: 'Royal Mail' }, total: '£50', termsUrl: null, delivery: { name: 'Next day', amount: 795 } });
        assert.ok(mail.html.includes('<strong>Delivery chosen:</strong> Next day — £7.95'));
        assert.ok(read('src/utils/site-shop.ts').includes("${delivery ? `<p><strong>Delivery:</strong> ${esc(deliveryLine(delivery, order.currency))}</p>` : ''}"), 'owner email');
    });

    console.log('\nStorage, Shop tab, chat and SQL');

    await check('no column yet → no delivery choices, and a save says it isn\'t switched on; a bad set-up never reaches the database', async () => {
        assert.strictEqual(await loadDelivery({ execute: async () => { throw missingColumn; } } as unknown as Db, 3), null);
        const off = await saveDelivery({ execute: async () => { throw missingColumn; } } as unknown as Db, 3, { rates: [{ name: 'A', price: 1 }] });
        assert.ok(!off.ok && off.status === 503);
        const bad = await saveDelivery(null as unknown as Db, 3, { rates: [{ name: 'A', price: 'x' }] });
        assert.ok(!bad.ok && bad.status === 400);
        let stored = '';
        const ok = await saveDelivery({ execute: async (q: unknown) => { stored = sqlText(q); return []; } } as unknown as Db, 3, { rates: [{ name: 'Standard', price: '3.50' }] });
        assert.ok(ok.ok && stored.includes('ON CONFLICT (organisation_id) DO UPDATE SET delivery') && stored.includes('\\"zones\\"'));
    });

    await check('the chat sees the choices; one owner/admin action for the Shop tab card and the chat card', () => {
        assert.match(deliverySnapshotLines(SETUP).join('\n'), /DELIVERY CHOICES \(buyers pick one at checkout; basket orders only\): Royal Mail Tracked 48 £3.95/);
        assert.match(deliverySnapshotLines(null).join('\n'), /none set/);
        assert.deepStrictEqual(deliverySnapshotLines(undefined), []);
        const fn = read('netlify/functions/shop.ts');
        assert.ok(fn.includes("if (action === 'delivery_rates') {") && fn.includes("if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can change the delivery choices.' });"));
        const tab = read('src/components/assistant-shop.js');
        assert.ok(tab.includes("action: 'delivery_rates', rates, collect") && tab.includes('${deliveryCard(state.data)}'));
        const reg = read('src/components/disruptive-ui-registry.js');
        assert.ok(reg.includes("register('delivery_rates', renderDeliveryRatesCard);") && reg.includes("new CustomEvent('shop:deliveryRates'"));
        const chat = read('src/components/chat-session.js');
        assert.ok(chat.includes("container.addEventListener('shop:deliveryRates', onDeliveryRates);") && chat.includes("container.removeEventListener('shop:deliveryRates', onDeliveryRates);"));
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('emit {"type":"delivery_rates","rates":[{"name":') && !orch.includes('or add delivery rates — those are coming'));
        assert.ok(read('src/config/chat-capabilities.generated.ts').includes('"delivery_rates"'));
    });

    await check('SQL additive; the columns stay out of db/schema.ts (whole-row selects/inserts)', () => {
        const q = read('db/z-shop-delivery.sql');
        assert.ok(q.includes('ADD COLUMN IF NOT EXISTS delivery JSONB') && q.includes('ADD COLUMN IF NOT EXISTS delivery_name') && q.includes('ADD COLUMN IF NOT EXISTS delivery_amount'));
        assert.strictEqual(classifySql(q).safety, 'additive');
        const schema = read('db/schema.ts');
        assert.ok(!schema.includes('"delivery_name"') && !schema.includes('delivery: jsonb'));
    });

    console.log(`\n${passed}/${total} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
