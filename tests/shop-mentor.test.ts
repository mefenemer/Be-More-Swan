// tests/shop-mentor.test.ts
// The Business Mentor watches the shop (online shop Phase 2, slice 8; feature request #35, docs/online-shop-review-plan.md
// §12): the morning summary's "Your shop" section and email line, and the Mentor snapshot's shop facts with the
// never-a-price rule. The SQL is proven by tests/shop-mentor-db.test.ts (CI's rls job).
//
// Run:  npx tsx tests/shop-mentor.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shopMorningLines, shopSnapshotForMentor, type ShopWatch } from '../src/utils/shop-mentor';
import { buildMorningSummary, morningEmailVars, morningMessage, type MorningInputs } from '../src/utils/mentor-morning';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const W: ShopWatch = { bestSeller: { name: 'Fig candle', units: 6 }, low: [{ name: 'Lavender candle', left: 2 }], soldOut: ['Mug'], slow: [{ id: 14, name: 'Cedar candle' }] };
const none = (o: Partial<MorningInputs> = {}): MorningInputs => ({
    sales: [], deposits: { count: 0, totalPence: 0 }, won: null, bookingsToday: 0, bookingRequests: 0, enquiriesOpen: 0, enquiriesYesterday: 0,
    postsAwaitingReview: 0, actionsAwaiting: 0, openSuggestions: 0, bestPost: null, ...o,
});

console.log('\nshop-mentor');

check('morning lines: best seller and stock, never "slow" (that is for the weekly review); nothing without a shop', () => {
    assert.deepStrictEqual(shopMorningLines(W), [
        'Best seller this week: Fig candle (6 sold)',
        'Low stock: Lavender candle (2 left) (Shopkeeper ▸ Shop)',
        'Sold out: Mug (Shopkeeper ▸ Shop)',
    ]);
    assert.deepStrictEqual(shopMorningLines(null), []);
    assert.deepStrictEqual(shopMorningLines({ bestSeller: null, low: [], soldOut: [], slow: [{ id: 1, name: 'X' }] }), []);
});

check('the summary: "Your shop" after Yesterday, only on a day with other news; the email carries it on the Yesterday line', () => {
    const s = buildMorningSummary(none({ sales: [{ currency: 'gbp', count: 2, total: 2400 }], shop: W }), '2026-11-27');
    assert.deepStrictEqual(s.sections.map((x) => x.key), ['money', 'shop']);
    assert.ok(morningMessage(s).includes('Your shop\n• Best seller this week: Fig candle (6 sold)'));
    const v = morningEmailVars(s);
    assert.ok(v.money.startsWith('Yesterday: 2 website sales, £24') && v.money.includes(' · Your shop: Best seller this week: Fig candle (6 sold)'));
    // review #910: lasting stock states are not news — the shop alone never makes a summary go out.
    assert.strictEqual(buildMorningSummary(none({ shop: W }), '2026-11-27').sections.length, 0, 'a quiet day with only a sold-out product sends nothing');
    const withEnq = buildMorningSummary(none({ enquiriesOpen: 1, shop: W }), '2026-11-27');
    assert.deepStrictEqual(withEnq.sections.map((x) => x.key), ['shop', 'enquiries']);
    assert.ok(morningEmailVars(withEnq).money.startsWith('Your shop: '), 'still on the Yesterday line on a day with no sales');
    assert.strictEqual(buildMorningSummary(none({ shop: null }), '2026-11-27').sections.length, 0, 'no shop: nothing new');
});

check('the Mentor snapshot: facts, the slow products with ids, and never a price', () => {
    const lines = shopSnapshotForMentor(W).join('\n');
    assert.ok(lines.includes('YOUR SHOP (facts from the Shopkeeper; the owner sets every price — never name or suggest a price figure)'));
    assert.ok(lines.includes('Best seller, last 7 days: Fig candle, 6 sold') && lines.includes('Low stock: Lavender candle (2 left)') && lines.includes('sold out: Mug'));
    assert.ok(lines.includes('NOT SOLD IN 60 DAYS') && lines.includes('Cedar candle (#14)') && lines.includes('never propose a number, a discount or a sale yourself'));
    assert.deepStrictEqual(shopSnapshotForMentor(null), []);
    assert.ok(!shopSnapshotForMentor({ ...W, slow: [] }).join('\n').includes('NOT SOLD'));
});

check('wired: the morning summary and the snapshot read it; the Mentor\'s own description of the summary says so', () => {
    const m = read('src/utils/mentor-morning.ts');
    assert.ok(m.includes('shop: await loadShopWatch(db, orgId),') && m.includes("the shop's best seller this week, low stock and sold-out products"));
    const snap = read('src/utils/mentor-snapshot.ts');
    assert.ok(snap.includes('const shop = await loadShopWatch(db, orgId);') && snap.includes('lines.push(...shopSnapshotForMentor(d.shop));'));
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/shop-mentor-db.test.ts'));
});

console.log(`\n${passed}/${total} passed`);
