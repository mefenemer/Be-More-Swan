// tests/shop-sales.test.ts
// "Ask your shop" (online shop Phase 2, slice 1; feature request #35, docs/online-shop-review-plan.md §12): the
// pure wording of src/utils/shop-sales.ts and where it reaches. The SQL is proven on Postgres by
// tests/shop-sales-db.test.ts (CI's rls job).
//
// Run:  npx tsx tests/shop-sales.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    monthName, monthSummary, moneyWords, previousMonth, rankBestSellers, salesMonthWords, salesSnapshotLines,
    WAITING_SHOWN, type ShopSales,
} from '../src/utils/shop-sales';
import { shopSnapshotText } from '../src/utils/shop-snapshot';
import { EMPTY_SHOP_SETTINGS } from '../src/utils/shop-settings';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const base: ShopSales = { months: [], thisMonth: '2026-11', bestThisMonth: [], bestRecent: [], waitingCount: 0, waiting: [] };

console.log('\nshop-sales');

check('money per currency, biggest first, never added together; months by name; January → December', () => {
    assert.strictEqual(moneyWords({ GBP: 34000, EUR: 2050 }), '£340 + €20.50');
    assert.strictEqual(moneyWords({}), '£0');
    assert.strictEqual(monthName('2026-10'), 'October 2026');
    assert.strictEqual(previousMonth('2026-01'), '2025-12');
    assert.strictEqual(previousMonth('2026-11'), '2026-10');
});

check('best sellers: units first, then money, then name; blank names kept readable', () => {
    const r = rankBestSellers([
        { name: 'Mug', units: 2, amount: 1600, currency: 'gbp' },
        { name: 'Fig candle', units: 2, amount: 2400, currency: 'gbp' },
        { name: 'Mug', units: 1, amount: 800, currency: 'gbp' },
        { name: '', units: 1, amount: 100, currency: 'gbp' },
    ]);
    assert.deepStrictEqual(r.map((b) => [b.name, b.units]), [['Mug', 3], ['Fig candle', 2], ['Unnamed item', 1]]);
    assert.strictEqual(rankBestSellers(Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, units: 1, amount: 1, currency: 'gbp' }))).length, 5);
});

check('this month / last month for the Shop tab, zero when a month had no orders', () => {
    const s: ShopSales = { ...base, months: [{ month: '2026-11', orders: 12, sold: { GBP: 34000 } }] };
    const m = monthSummary(s);
    assert.strictEqual(salesMonthWords(m.thisMonth), '12 orders, £340 sold');
    assert.strictEqual(salesMonthWords(m.lastMonth), '0 orders, £0 sold');
});

check('snapshot lines: months, together-total, both best-seller windows, waiting list with a cap', () => {
    const s: ShopSales = {
        ...base,
        months: [{ month: '2026-11', orders: 1, sold: { GBP: 1200 } }, { month: '2026-10', orders: 3, sold: { GBP: 3000, EUR: 500 } }],
        bestThisMonth: [{ name: 'Fig candle', units: 1, sold: { GBP: 1200 } }],
        waitingCount: 31,
        waiting: Array.from({ length: WAITING_SHOWN }, (_, i) => ({ id: i + 1, date: '2026-11-01', itemName: 'Mug', quantity: 1, customerName: i ? null : 'Jo' })),
    };
    const t = salesSnapshotLines(s).join('\n');
    assert.ok(t.includes('November 2026 is this month, so far'));
    assert.ok(t.includes('- October 2026: 3 orders, £30 + €5 sold'));
    assert.ok(t.includes('Last 12 months together: 4 orders, £42 + €5 sold. Months not listed had no orders.'));
    assert.ok(t.includes('1. Fig candle: 1 sold, £12') && t.includes('BEST SELLERS LAST 90 DAYS: nothing sold yet.'));
    assert.ok(t.includes(`31 orders; the oldest ${WAITING_SHOWN} listed`) && t.includes('- #1 2026-11-01: 1 × Mug, Jo') && t.includes('- #2 2026-11-01: 1 × Mug, a buyer'));
    assert.ok(salesSnapshotLines(base).join('\n').includes('WAITING TO BE POSTED: none'));
    assert.deepStrictEqual(salesSnapshotLines(null), []);
});

check('the chat snapshot carries the lines after ORDERS (only when there are orders)', () => {
    const order = { id: 9, itemName: 'Mug', quantity: 1, amountTotal: 800, currency: 'gbp', customerName: 'Jo', status: 'paid', refundedAmount: 0, createdAt: new Date('2026-11-02T10:00:00Z') };
    const withSales = shopSnapshotText({ connected: true, chargesEnabled: true, shop: { ...EMPTY_SHOP_SETTINGS }, orders: [order], sales: { ...base, waitingCount: 1, waiting: [{ id: 9, date: '2026-11-02', itemName: 'Mug', quantity: 1, customerName: 'Jo' }] } });
    assert.ok(withSales.indexOf('SALES (every order') > withSales.indexOf('ORDERS (newest'));
    const none = shopSnapshotText({ connected: true, chargesEnabled: true, shop: { ...EMPTY_SHOP_SETTINGS }, orders: [], sales: base });
    assert.ok(none.includes('ORDERS: none yet.') && !none.includes('SALES ('));
});

check('wiring: snapshot reads it, the prompt answers from it, order_update may match a WAITING order, Shop tab line', () => {
    const snap = read('src/utils/shop-snapshot.ts');
    assert.ok(snap.includes('const sales = orders.length ? await loadShopSales(db, orgId)'));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('SALES. "How much did I sell in October?"') && orch.includes('Never add amounts in different currencies together'));
    assert.ok(orch.includes('match it to ONE order in the ORDERS list (or, for an older one, the WAITING TO BE POSTED list)'));
    assert.ok(read('netlify/functions/shop.ts').includes('sales: orders.length ? await loadShopSales(db, orgId)'));
    assert.ok(read('src/components/assistant-shop.js').includes('data-shop-sales>This month: '));
});

check('the SQL test runs in CI\'s Postgres job', () => {
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/shop-sales-db.test.ts'));
});

console.log(`\n${passed}/${total} passed`);
