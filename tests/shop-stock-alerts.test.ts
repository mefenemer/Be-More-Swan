// tests/shop-stock-alerts.test.ts
// "Stock that talks" (online shop Phase 2, slice 2; feature request #35, docs/online-shop-review-plan.md §12):
// src/utils/shop-stock-alerts.ts wording + crossing rule, and where it is wired. Stock-taking itself on Postgres:
// tests/shop-stock-alerts-db.test.ts (CI's rls job).
//
// Run:  npx tsx tests/shop-stock-alerts.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stockAlertMessage, stockAlertTitle, stockCrossing } from '../src/utils/shop-stock-alerts';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const t = (before: number, after: number, lowStockAt: number | null) => ({ before, after, lowStockAt });

console.log('\nshop-stock-alerts');

check('alerts only when THIS order crossed the line: once into low, once at 0; sold out wins', () => {
    assert.strictEqual(stockCrossing(t(12, 4, 3), 'Candle'), null);
    assert.deepStrictEqual(stockCrossing(t(4, 3, 3), 'Candle'), { name: 'Candle', kind: 'low', left: 3 });
    assert.strictEqual(stockCrossing(t(3, 2, 3), 'Candle'), null, 'already low: no repeat');
    assert.deepStrictEqual(stockCrossing(t(2, 0, 3), 'Candle'), { name: 'Candle', kind: 'sold_out', left: 0 });
    assert.deepStrictEqual(stockCrossing(t(5, 0, 3), 'Candle'), { name: 'Candle', kind: 'sold_out', left: 0 }, 'straight past low to 0: one sold-out alert');
    assert.strictEqual(stockCrossing(t(0, 0, 3), 'Candle'), null, 'oversold at 0 already: nothing new');
    assert.strictEqual(stockCrossing(t(9, 2, null), 'Candle'), null, 'no level set: only sold out alerts');
    assert.strictEqual(stockCrossing(t(9, 2, 0), 'Candle'), null);
    assert.strictEqual(stockCrossing(null, 'Candle'), null, 'not tracked');
});

check('words: one alert, several alerts; bell template renders them', () => {
    assert.strictEqual(stockAlertTitle([{ name: 'Fig candle — Large', kind: 'sold_out', left: 0 }]), 'Sold out: Fig candle — Large');
    assert.strictEqual(stockAlertTitle([{ name: 'Mug', kind: 'low', left: 3 }]), 'Low stock: 3 left of Mug');
    assert.strictEqual(stockAlertTitle([{ name: 'Mug', kind: 'low', left: 3 }, { name: 'Tote', kind: 'sold_out', left: 0 }]), 'Stock: 2 products need you');
    assert.strictEqual(stockAlertMessage([{ name: 'Mug', kind: 'low', left: 3 }]), '3 left of Mug — that\'s the low-stock level you set. Set a new count on the Shop tab when more arrive.');
    const many = stockAlertMessage([{ name: 'Mug', kind: 'low', left: 3 }, { name: 'Tote', kind: 'sold_out', left: 0 }]);
    assert.ok(many.startsWith('After the latest order:\n• 3 left of Mug') && many.includes('• Tote is sold out — it shows Sold out on your website now.'));
    const tpl = getNotificationDefault('shop_stock_alert');
    assert.ok(tpl && tpl.title === '{{stock.title}}' && tpl.message === '{{stock.message}}');
});

check('wiring: recordPaidCheckout collects crossings for basket lines AND single Buy orders, then sends once', () => {
    const shop = read('src/utils/site-shop.ts');
    assert.strictEqual(shop.split('stockCrossing(r.taken,').length - 1, 2);
    assert.ok(shop.includes("await sendStockAlerts(db, { orgId: site.organisationId, ownerUserId: owner?.userId ?? null, orderId: order.id, alerts: stockAlerts });"));
    const mod = read('src/utils/shop-stock-alerts.ts');
    assert.ok(mod.includes("link: { assistantId: keeper.id, tab: 'datahub', label: 'Open the Shop tab' }") && mod.includes("eq(aiAssistants.isActive, true)"));
});

check('options warn at their product\'s level: Shop tab box, chat snapshot + prompt', () => {
    assert.ok(read('src/utils/shop-options.ts').includes('const lowStockAt = await productLowStockAt(db, orgId, optionId);'));
    const tab = read('src/components/assistant-shop.js');
    assert.ok(tab.includes("num('data-stock-low', it.lowStockAt, 'Warn me when any option gets to')") && tab.includes("...(row.querySelector('[data-stock-count]') ? { stock:"));
    assert.ok(read('src/utils/shop-snapshot.ts').includes('product_stock only sets lowStockAt here, which warns for EACH option'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('product_stock with lowStockAt only (never stock) sets it.'));
});

check('the Postgres test runs in CI', () => {
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/shop-stock-alerts-db.test.ts'));
});

console.log(`\n${passed}/${total} passed`);
