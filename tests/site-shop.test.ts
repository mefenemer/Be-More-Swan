// tests/site-shop.test.ts
// The Website Assistant, step 3c: selling on hosted sites through each workspace's own Stripe
// STANDARD account, with no fee to us (decisions D4, D5). src/utils/site-shop.ts, the products
// section (site-definition.ts / site-render.ts), site-serve.ts /_buy and stripe-connect-webhook.ts.
//
// Run:  npx tsx tests/site-shop.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { formatPrice, renderSitePage, BUY_ACTION } from '../src/utils/site-render';
import { checkoutParams, findProduct, MAX_QUANTITY, startCheckout } from '../src/utils/site-shop';
import { siteFromDraftReply, starterSite } from '../src/utils/site-draft';
import { WORKSPACE_TABLES } from '../src/utils/workspace-export';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';
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
const shop = (items: unknown[], extra: Record<string, unknown> = {}): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee' },
    pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Fresh coffee' } }] },
        { title: 'Shop', slug: 'shop', sections: [{ type: 'products', props: { heading: 'Our coffee', items, ...extra } }] },
    ],
}).definition;
const row: SiteRow = {
    id: 9, organisationId: 3, aiAssistantId: 4, createdBy: null, status: 'published', draft: {}, slug: 'willowbrook', credit: true,
    draftingAt: null, draftNote: null, createdAt: new Date(), updatedAt: new Date(), publishedVersion: 1, publishedAt: null,
    suspendedAt: null, suspendedReason: null,
};
const live = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };

async function main() {
    console.log('\nThe products section');

    await check('prices are whole pence within Stripe\'s minimum and a sane ceiling; a bad price is dropped, not the item', () => {
        const warnings: string[] = [];
        const d = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'products', props: { items: [
            { name: 'Beans', price: 1250 }, { name: 'Sample', price: 10 }, { name: 'Mug', price: '899.6' }, { name: 'Gift card', price: null }, { name: '', price: 500 },
        ] } }] }] });
        warnings.push(...d.warnings);
        const items = (d.definition.pages[0].sections[0].props as { items: Array<{ name: string; price: number | null }> }).items;
        assert.deepStrictEqual(items.map((i) => [i.name, i.price]), [['Beans', 1250], ['Sample', null], ['Mug', 900], ['Gift card', null]]);
        assert.ok(warnings.some((w) => /between £0.30/.test(w)));
        assert.strictEqual(LIMITS.minPrice, 30);
    });

    await check('formatPrice: pounds sterling, pence only when there are some', () => {
        assert.strictEqual(formatPrice(1250), '£12.50');
        assert.strictEqual(formatPrice(1200), '£12');
        assert.strictEqual(formatPrice(123456), '£1,234.56');
    });

    await check('Buy buttons appear only on the live site, only with a price, and only once Stripe can take payments', () => {
        const d = shop([{ name: 'House Blend', price: 1250, description: 'Our everyday coffee.' }, { name: 'Wholesale', price: null }]);
        const selling = renderSitePage(d, '/shop', { ...live, canSell: true }).html;
        assert.strictEqual((selling.match(new RegExp(`action="${BUY_ACTION}"`, 'g')) || []).length, 1, 'one priced item → one Buy form');
        assert.ok(selling.includes('name="_n" value="House Blend"') && selling.includes('name="_i" value="0"'));
        assert.ok(!selling.includes('name="price"') && !/value="1250"/.test(selling), 'the price is never sent by the browser');
        assert.ok(selling.includes('£12.50'));
        assert.ok(selling.includes('"@type":"Product"') && selling.includes('"price":"12.50"') && selling.includes('"priceCurrency":"GBP"'));
        const notConnected = renderSitePage(d, '/shop', { ...live, canSell: false }).html;
        assert.ok(!notConnected.includes(`action="${BUY_ACTION}"`) && notConnected.includes('£12.50'), 'shown with its price, no button');
        const preview = renderSitePage(d, '/shop', { ...live, preview: true, canSell: true }).html;
        assert.ok(!preview.includes(`action="${BUY_ACTION}"`) && preview.includes('disabled') && preview.includes('Orders tab'));
    });

    await check('the AI draft never puts things up for sale', () => {
        const current = starterSite({ name: 'Willowbrook', industry: null, description: 'Coffee.', audience: null, websiteUrl: null, email: null }, normaliseSiteDefinition({}).definition.theme);
        const r = siteFromDraftReply({ pages: [{ title: 'Home', slug: '', sections: [
            { type: 'hero', props: { headline: 'Coffee' } },
            { type: 'products', props: { items: [{ name: 'Beans', price: 999 }] } },
        ] }] }, current, 5);
        assert.ok(r && !r.definition.pages.some((p) => p.sections.some((s) => s.type === 'products')));
        assert.ok(!read('src/utils/site-draft.ts').includes('- "products"'), 'not offered in the draft schema');
    });

    console.log('\nCheckout');

    await check('the checkout is built from the PUBLISHED item: its price, its name, sterling, quantity 1–10, no fee', () => {
        const d = shop([{ name: 'House Blend', price: 1250, description: 'Everyday.', image: { url: 'https://img.example/b.jpg', alt: 'Bag' } }], { collectAddress: true });
        const found = findProduct(d, d.pages[1].sections[0].id, 0)!;
        const p = checkoutParams({ origin: live.origin, site: row, sectionId: d.pages[1].sections[0].id, index: 0, item: found.item, collectAddress: true, backPath: '/shop' });
        const line = p.line_items![0];
        assert.strictEqual(p.mode, 'payment');
        assert.deepStrictEqual(line.price_data!.unit_amount, 1250);
        assert.strictEqual(line.price_data!.currency, 'gbp');
        assert.strictEqual(line.price_data!.product_data!.name, 'House Blend');
        assert.deepStrictEqual(line.adjustable_quantity, { enabled: true, minimum: 1, maximum: MAX_QUANTITY });
        assert.deepStrictEqual(p.shipping_address_collection, { allowed_countries: ['GB'] });
        assert.strictEqual(p.success_url, 'https://willowbrook.bemoreswan.site/_sent?k=order&b=%2Fshop');
        assert.strictEqual(p.cancel_url, 'https://willowbrook.bemoreswan.site/shop');
        assert.strictEqual(p.metadata!.bms_site_id, '9');
        assert.strictEqual(p.metadata!.bms_unit, '1250');
        assert.ok(!('payment_intent_data' in p), 'no application fee — decision D5 (0%)');
        const src = read('src/utils/site-shop.ts');
        assert.ok(!/application_fee/.test(src.replace(/no application_fee_amount anywhere/, '')), 'nowhere in the shop code');
        assert.ok(src.includes('{ stripeAccount: account.stripeAccountId }'), 'the session is created ON the connected account');
    });

    await check('a stale or tampered Buy is refused before Stripe or the database is touched', async () => {
        const d = shop([{ name: 'House Blend', price: 1250 }, { name: 'Wholesale', price: null }]);
        const sid = d.pages[1].sections[0].id;
        const noDb = null as unknown as Parameters<typeof startCheckout>[0];
        const go = (o: Record<string, string>) => startCheckout(noDb, { site: row, definition: d, origin: live.origin, ip: '1.1.1.1', backPath: '/shop', body: new URLSearchParams(o) });
        const unpriced = await go({ _s: sid, _i: '1', _n: 'Wholesale' });
        assert.ok(unpriced.kind === 'error' && unpriced.status === 404);
        const changed = await go({ _s: sid, _i: '0', _n: 'Old Blend' });
        assert.ok(changed.kind === 'error' && changed.status === 409 && /changed/.test(changed.title));
        const missing = await go({ _s: 'nope', _i: '0', _n: 'House Blend' });
        assert.ok(missing.kind === 'error' && missing.status === 404);
    });

    await check('a checkout needs the workspace\'s account to be able to take payments, and is rate-limited', () => {
        const src = read('src/utils/site-shop.ts');
        const fn = src.slice(src.indexOf('export async function startCheckout'), src.indexOf('// ── Recording an order'));
        assert.ok(fn.indexOf('if (!account?.chargesEnabled)') < fn.indexOf('checkout.sessions.create('));
        assert.ok(fn.indexOf("checkRateLimit(db, 'site_buy_ip'") < fn.indexOf('checkout.sessions.create('));
    });

    console.log('\nOrders and the webhook');

    await check('the Connect webhook is its own endpoint, signature-checked with its own secret, and fails closed', () => {
        const fn = read('netlify/functions/stripe-connect-webhook.ts');
        assert.ok(fn.includes('process.env.STRIPE_CONNECT_WEBHOOK_SECRET'));
        assert.ok(fn.indexOf('if (!secret || !key)') < fn.indexOf('constructEvent('));
        assert.ok(fn.includes("if (!evt.account) return"));
        assert.ok(fn.includes("'checkout.session.completed'") && fn.includes("'checkout.session.async_payment_succeeded'") && fn.includes("'account.updated'"));
        assert.ok(!/plans|payments\b/.test(fn.replace(/\/\/.*$/gm, '')), 'never touches our own billing tables');
    });

    await check('an order is recorded only when paid, only for the account that workspace connected, and only once', () => {
        const src = read('src/utils/site-shop.ts');
        const fn = src.slice(src.indexOf('export async function recordPaidCheckout'), src.indexOf('export async function markOrderDone'));
        assert.ok(fn.indexOf("session.payment_status !== 'paid'") < fn.indexOf('db.insert(siteOrders)'));
        assert.ok(fn.indexOf('account.stripeAccountId !== accountId') < fn.indexOf('db.insert(siteOrders)'));
        assert.ok(fn.includes('.onConflictDoNothing({ target: siteOrders.checkoutSessionId })'));
        assert.ok(fn.includes("createNotification(db, 'site_order_received'") && fn.includes('to: owner.email'));
        assert.ok(read('db/z-website-shop.sql').includes('CREATE UNIQUE INDEX IF NOT EXISTS site_orders_session_uq ON site_orders (checkout_session_id)'));
    });

    await check('connecting Stripe: Standard account, owner/admin only, Stripe\'s own onboarding', () => {
        const src = read('src/utils/site-shop.ts');
        assert.ok(src.includes("type: 'standard'") && src.includes("type: 'account_onboarding'"));
        const api = read('netlify/functions/sites.ts');
        const connect = api.slice(api.indexOf("if (action === 'payments_connect')"), api.indexOf("if (action === 'payments_refresh')"));
        assert.ok(connect.indexOf("role !== 'owner' && role !== 'admin'") < connect.indexOf('connectOnboardingLink('));
        assert.ok(connect.includes('tab=sitebuilder'));
    });

    await check('serving: /_buy is the only other thing that may be posted; the page may post only to itself and Stripe Checkout', () => {
        const serve = read('netlify/functions/site-serve.ts');
        assert.ok(serve.includes("form-action 'self' https://checkout.stripe.com"));
        assert.ok(serve.includes('startCheckout(db, { site, definition, origin, ip'));
        assert.ok(serve.includes('canSell: hasShop ? await canSell(db, site.organisationId) : false'));
    });

    await check('registered, exported, migrated, and offered in the editor and the chat', () => {
        assert.ok(read('src/utils/notification-actions.ts').includes("site_order_received: 'state_change'"));
        assert.ok(read('src/utils/notification-prefs.ts').includes("'site_order_received'"));
        assert.ok(read('db/notifications-categorization.sql').includes("WHEN 'site_order_received' THEN 'state_change'"));
        assert.strictEqual(getNotificationDefault('site_order_received')?.type, 'site_order_received');
        assert.ok(WORKSPACE_TABLES.websiteOrders && WORKSPACE_TABLES.stripeConnectAccounts);
        assert.ok(read('db/schema.ts').includes('export const siteOrders = pgTable("site_orders"'));
        const ed = read('src/components/assistant-site-editor.js');
        assert.ok(ed.includes("products: 'Products for sale'") && ed.includes("kind: 'productItems'") && ed.includes("action: 'payments_connect'") && ed.includes("action: 'orders'"));
        const chat = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(chat.includes('price is in PENCE') && chat.includes('never estimate one'));
    });

    console.log(`\n${passed}/${total} passed`);
}

void main();
