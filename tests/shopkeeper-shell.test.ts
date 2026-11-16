// tests/shopkeeper-shell.test.ts
// The Shopkeeper Assistant shell (online shop FR#35, docs/online-shop-review-plan.md §10): a hidden
// catalogue role whose Shop tab (assistant-shop.js → shop.ts) holds Stripe, the Delivery & returns
// details and the workspace's orders, and whose chat reads the same and fills the details in through
// the shop_settings card on the same server action.
//
// Run:  npx tsx tests/shopkeeper-shell.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shopSnapshotText, type ShopSnapshotInput } from '../src/utils/shop-snapshot';
import { EMPTY_SHOP_SETTINGS, type ShopSettings } from '../src/utils/shop-settings';
import { ASSISTANT_BUILD } from '../src/config/assistant-build-manifest';
import { ROLE_CONNECTIONS } from '../src/utils/connection-map';
import { SHOPKEEPER_ROLE_KEY } from '../src/constants/roles';
import { chatCapabilitiesFor } from '../src/utils/assistant-chat-capabilities';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const READY: ShopSettings = {
    ...EMPTY_SHOP_SETTINGS,
    traderName: 'Willowbrook Coffee Ltd', traderAddress: '12 Mill Lane\nWillowbrook', contactEmail: 'hello@willowbrook.example',
    deliveryText: 'Royal Mail Tracked 48', exceptions: ['perishable'],
};
const ORDER = { id: 77, itemName: 'House Blend', quantity: 2, amountTotal: 2500, currency: 'gbp', customerName: 'Jo', status: 'paid', refundedAmount: 0, createdAt: new Date('2026-11-14T10:00:00Z') };

console.log('\nRegistered like every role, hidden');

check('role key, hidden catalogue row (SQL + fresh-database seed), build manifest', () => {
    assert.strictEqual(SHOPKEEPER_ROLE_KEY, 'shopkeeper');
    const sql = read('db/z-shopkeeper.sql');
    assert.ok(sql.includes("VALUES ('shopkeeper', 'Shopkeeper Assistant'") && sql.includes("false, false, 'draft')") && sql.includes('ON CONFLICT (role_key) DO NOTHING'));
    assert.ok(/roleKey: 'shopkeeper',[\s\S]{0,700}isActive: false/.test(read('db/seed-catalog.ts')));
    assert.deepStrictEqual(ASSISTANT_BUILD.shopkeeper, { setup: 'schema', chat: true, dashboard: true });
});

check('set-up questions, welcome message, mandate suggestions, connections, words on the capabilities page', () => {
    assert.ok(/shopkeeper: \[[\s\S]{0,400}whatYouSell[\s\S]{0,1200}hasWebsite/.test(read('src/public/assistant-onboarding-schemas.js')));
    assert.ok(read('src/components/assistant-welcome-messages.js').includes('shopkeeper: {'));
    assert.ok(read('src/public/mandate-suggestions.js').includes('shopkeeper: ['));
    assert.deepStrictEqual(ROLE_CONNECTIONS.shopkeeper, ['knowledge']);
    const caps = chatCapabilitiesFor('shopkeeper');
    assert.ok(caps.hasRoute && caps.described);
});

check('the dashboard: a Shop tab of its own kind and Results cards from shop.ts', () => {
    const reg = read('src/components/assistant-dashboard-registry.js');
    assert.ok(/shopkeeper: \{[\s\S]{0,400}metricsSource: 'shop'[\s\S]{0,2500}kind: 'shop',\s*label: 'Shop'/.test(reg));
    const a = read('assistants.js');
    assert.ok(a.includes("else if (hub.kind === 'shop') window.AssistantShop?.init("));
    assert.ok(a.includes("else if (hubKind === 'shop') window.AssistantShop?.refresh?.();"), 'opening the tab refreshes the Shop, not a stale Data Hub');
    assert.ok(a.includes("if (source === 'shop') {") && a.includes('async function _loadShopMetrics(assistantId)'));
    assert.ok(read('workspace.html').includes('<script src="/src/components/assistant-shop.js"></script>'));
});

check('browser check 2026-11-16: the question button asks it, Results says "No orders yet", the chat names the real button', () => {
    assert.ok(read('src/components/assistant-dashboard-registry.js').includes("primaryAction: { label: 'Is my shop ready to sell?', kind: 'chat', send: 'Is my shop ready to sell?' }"));
    const a = read('assistants.js');
    assert.ok(a.includes('if (dock) { dock.ask(pa.send); return; }'), 'asked in the docked chat, not a second pop-up');
    assert.ok(a.includes("...(pa.send ? { send: pa.send } : {})"), 'no dock: the pop-up sends it');
    assert.ok(a.includes("_setMetricsEmptyState('shop-no-data')") && a.includes("mode === 'shop-no-data'") && a.includes("title.textContent = 'No orders yet'"));
    const at = a.indexOf("mode === 'shop-no-data'");
    const shopEmpty = a.slice(at, a.indexOf("mode === 'records-no-data'", at));
    assert.ok(shopEmpty.length > 0 && !/spreadsheet|Data Hub/.test(shopEmpty), 'no Data Hub on the Shopkeeper');
    const o = read('netlify/functions/chat-orchestrator.ts');
    const route = o.slice(o.indexOf('    shopkeeper: {'), o.indexOf('    business_mentor: {'));
    assert.ok(route.includes('"Save details" button') && route.includes('IS IT READY?'));
});

console.log('\nThe Shop tab and its server');

check('shop.ts: this workspace\'s Shopkeeper only; shop_settings also takes the Website Assistant', () => {
    const fn = read('netlify/functions/shop.ts');
    assert.ok(fn.includes("const roles = action === 'shop_settings' ? [SHOPKEEPER_ROLE_KEY, WEBSITE_ASSISTANT_ROLE_KEY] : [SHOPKEEPER_ROLE_KEY];"));
    assert.ok(fn.includes('eq(aiAssistants.organisationId, orgId)'));
    for (const a of ['get', 'shop_settings', 'payments_connect', 'payments_refresh', 'order_done']) assert.ok(fn.includes(`action === '${a}'`), a);
    assert.ok(fn.includes("if (!canEdit) return json(403") , 'owner/admin only for changes');
    assert.ok(!fn.includes('application_fee_amount'), '0% on sales, forever (decision 4)');
    assert.ok(fn.includes('&tab=datahub&payments=return'), 'Stripe sends them back to the Shop tab');
});

check('orders are the workspace\'s (no website needed), and a refund stays a refund', () => {
    const fn = read('netlify/functions/shop.ts');
    assert.ok(fn.includes('.from(siteOrders).where(eq(siteOrders.organisationId, orgId))'));
    const shop = read('src/utils/site-shop.ts');
    assert.ok(/export async function markShopOrderDone[\s\S]{0,400}eq\(siteOrders\.organisationId, orgId\), ne\(siteOrders\.status, 'refunded'\)/.test(shop));
});

check('the tab: two steps, Stripe, the details form, orders; sends the same action as the chat card', () => {
    const js = read('src/components/assistant-shop.js');
    assert.ok(js.includes("const API = '/.netlify/functions/shop';"));
    assert.ok(js.includes("post({ action: 'shop_settings', settings })") && js.includes("post({ action: 'payments_connect' })") && js.includes("action: 'order_done'"));
    assert.ok(js.includes("document.addEventListener('shop:changed'"), 'a chat-card save shows on the tab');
    assert.ok(js.includes("if (!state.bound) { document.addEventListener('click', onClick); state.bound = true; }"), 'bound once, never from render');
});

console.log('\nThe chat');

check('the shopkeeper route reads the shop every turn and offers the shop_settings card', () => {
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(/    shopkeeper: \{[\s\S]{0,200}usesShopSnapshot: true/.test(o));
    assert.ok(o.includes('const shopSnapshot = route.usesShopSnapshot'));
    assert.ok(/shopkeeper: \{[\s\S]*?"type": "shop_settings"[\s\S]*?business_mentor: \{/.test(o));
    const cs = read('src/components/chat-session.js');
    assert.ok(cs.includes("fetch('/.netlify/functions/shop', {") && cs.includes("new CustomEvent('shop:changed'"));
});

check('snapshot: not connected, details missing → can NOT take orders, and no orders', () => {
    const t = shopSnapshotText({ connected: false, chargesEnabled: false, shop: null, orders: [] });
    assert.ok(t.includes('Stripe NOT connected') && t.includes('NOT complete — missing Business or trading name') && t.includes('can NOT take orders') && t.includes('ORDERS: none yet.'));
});

check('snapshot: ready → CAN take orders; orders listed with what, how much, who and state; no buyer email or address', () => {
    const input: ShopSnapshotInput = {
        connected: true, chargesEnabled: true, shop: READY,
        orders: [ORDER, { ...ORDER, id: 78, status: 'refunded', refundedAmount: 2500 }, { ...ORDER, id: 79, status: 'done', refundedAmount: 500 }],
    };
    const t = shopSnapshotText(input);
    assert.ok(t.includes('Stripe connected and taking payments') && t.includes('Delivery & returns details: complete.') && t.includes('the shop CAN take orders now'));
    assert.ok(t.includes('#77 2026-11-14: 2 × House Blend, £25, Jo — NEW'));
    assert.ok(t.includes('#78') && t.includes('— refunded') && t.includes('part refunded (£5)'));
    assert.ok(t.includes('1 not yet marked as dealt with'));
    assert.ok(t.includes('items that go off quickly') || t.includes('go off'), 'the exceptions they ticked');
    assert.ok(!t.includes('12 Mill Lane'), 'address not repeated into the prompt');
});

check('snapshot: Stripe started but not finished says so', () => {
    assert.ok(shopSnapshotText({ connected: true, chargesEnabled: false, shop: READY, orders: [] }).includes('Stripe started but NOT finished'));
});

console.log(`\n${passed}/${total} passed`);
