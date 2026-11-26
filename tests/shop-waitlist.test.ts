// tests/shop-waitlist.test.ts
// "Tell me when it's back" (online shop Phase 2, slice 6; feature request #35, docs/online-shop-review-plan.md §12):
// the sold-out product page's box, the buyable rule, the Team Chat question and its answer, the email's words, the
// Shop tab and chat wiring. The SQL paths are proven by tests/shop-waitlist-db.test.ts (CI's rls job).
//
// Run:  npx tsx tests/shop-waitlist.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backInStockEmail, backInStockQuestion, buyableFrom, sendResultWords, BACK_IN_STOCK_CHOICES, SEND_BATCH, WAITLIST_ACTION } from '../src/utils/shop-waitlist';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSiteProduct } from '../src/utils/site-render';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('\nshop-waitlist');

const DEF = normaliseSiteDefinition({
    settings: { siteName: 'Kudzu Candles' },
    pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'x' } }] }, { title: 'Shop', slug: 'shop', sections: [{ type: 'products', props: { heading: 'Candles', productIds: [7] } }] }],
}).definition;
const live = { origin: 'https://kudzu.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, canSell: true, waitlist: true } as never;
const base = { id: 7, name: 'Lavender candle', description: null, price: '£12', buyPence: 1200, imageAssetId: null };
const page = (p: object, basket = true, ctx: object = live) => renderSiteProduct(DEF, { ...(ctx as object), ...(basket ? { basket: { on: true, id: null, count: 0 } } : {}) } as never, { ...base, ...p } as never)!;

check('buyable: options → any option left; no options → stock untracked or above 0', () => {
    assert.strictEqual(buyableFrom(null, []), true);
    assert.strictEqual(buyableFrom(3, []), true);
    assert.strictEqual(buyableFrom(0, []), false);
    assert.strictEqual(buyableFrom(5, [{ stock: 0 }, { stock: 0 }]), false, 'options decide, as on the page');
    assert.strictEqual(buyableFrom(0, [{ stock: 0 }, { stock: null }]), true);
    assert.strictEqual(buyableFrom(0, [{ stock: 0 }, { stock: 2 }]), true);
});

check('the product page: the box only under a WHOLLY sold-out product, only in a Shopkeeper workspace, never in a preview', () => {
    const sold = page({ stock: 0 });
    assert.ok(sold.includes('data-waitlist') && sold.includes(`name="_a" value="${WAITLIST_ACTION}"`) && sold.includes('name="_email" required'));
    assert.ok(sold.includes('name="_pid" value="7"') && sold.includes("Tell me when it's back"));
    assert.ok(!page({ stock: 3 }).includes('data-waitlist'), 'in stock: no box');
    assert.ok(!page({ stock: null }).includes('data-waitlist'), 'untracked: no box');
    assert.ok(!page({ stock: 0 }, false).includes('data-waitlist'), 'no basket (website-only shop): no box');
    assert.ok(!page({ stock: 0 }, true, { ...(live as object), preview: true }).includes('data-waitlist'), 'preview: no box');
    assert.ok(!page({ stock: 0 }, true, { ...(live as object), waitlist: false }).includes('data-waitlist'), 'review #908: no box before db/z-shop-waitlist.sql');
    const opts = (stocks: Array<number | null>) => ({ stock: null, options: { group: 'Size', options: stocks.map((st, i) => ({ id: i + 1, label: `S${i}`, priceAmount: null, stock: st })) } });
    assert.ok(page(opts([0, 0])).includes('data-waitlist'), 'every option sold out: box');
    assert.ok(!page(opts([0, 2])).includes('data-waitlist'), 'one option left: no box');
});

check('the Team Chat question, its buttons, and what a send says', () => {
    assert.strictEqual(backInStockQuestion('Lavender candle', 6), 'Lavender candle is back in stock. Email the 6 people waiting to hear?');
    assert.strictEqual(backInStockQuestion('Fig candle', 1), 'Fig candle is back in stock. Email the 1 person waiting to hear?');
    assert.deepStrictEqual(BACK_IN_STOCK_CHOICES.map((c) => c.value), ['send', 'later']);
    assert.strictEqual(sendResultWords('Lavender candle', { ok: true, sent: 5, skipped: 1, failed: 0, left: 0 }), 'Emailed 5 people that Lavender candle is back. 1 skipped: they unsubscribed from your emails or can\'t be emailed.');
    assert.ok(sendResultWords('X', { ok: true, sent: SEND_BATCH, skipped: 0, failed: 0, left: 12 }).includes('12 still waiting: press "Email them"'));
    assert.strictEqual(sendResultWords('X', { ok: false, error: 'Nobody was emailed: no route.' }), 'Nobody was emailed: no route.');
});

check('the email: the product, a link to it, why they got it; never a price; escaped', () => {
    const m = backInStockEmail({ business: 'Kudzu <Candles>', product: 'Lavender candle', productUrl: 'https://kudzu.bemoreswan.site/shop/7-lavender-candle' });
    assert.strictEqual(m.subject, 'Lavender candle is back in stock — Kudzu <Candles>');
    assert.ok(m.html.includes('Kudzu &lt;Candles&gt;') && m.html.includes('href="https://kudzu.bemoreswan.site/shop/7-lavender-candle"'));
    assert.ok(m.html.includes('only email') && m.text.includes('If that wasn\'t you, ignore it'), 'review #908: says what to do if they never asked');
    assert.ok(!/£|\d+\.\d\d/.test(m.html + m.text));
    assert.ok(!backInStockEmail({ business: 'K', product: 'P', productUrl: null }).html.includes('href='));
});

check('wired: /_buy notify, stock saves ask, the answer sends, Shop tab button, chat snapshot, sweep; own route only', () => {
    const shop = read('src/utils/site-shop.ts');
    assert.ok(shop.includes('if (act === WAITLIST_ACTION) return waitlistAction(db, req);'));
    const w = shop.slice(shop.indexOf('async function waitlistAction('));
    assert.ok(w.indexOf('basketOn(db, orgId)') < w.indexOf('joinWaitlist(') && w.indexOf("rateLimited(db, req.ip, back, 'site_waitlist_ip', WAITLIST_LIMIT)") < w.indexOf('joinWaitlist('), 'Shopkeeper only, rate-limited, before joining');
    assert.ok(w.includes("section.props.productIds.includes(productId)"), 'only a product the published site offers');
    const api = read('netlify/functions/shop.ts');
    assert.ok((api.match(/const before = await productBuyable\(db, orgId, Number\(body\.productId\)\)/g) || []).length === 2, 'both stock saves');
    assert.ok(api.includes("if (action === 'waitlist_send') {") && api.includes('waiting: await waitingCounts(db, orgId),'));
    const team = read('src/utils/team-messages.ts');
    // review #908: only the owner or an admin may answer "Email them", refused before the question is claimed.
    assert.ok(team.includes("const OWNER_ONLY_ANSWERS: Partial<Record<QuestionKey, string[]>> = { back_in_stock: ['send'] };"));
    assert.ok(team.indexOf("args.role !== 'owner' && args.role !== 'admin'") < team.indexOf('// Claim it first, so two clicks'));
    assert.ok(read('netlify/functions/team.ts').includes('answerQuestion(db, { orgId, userId, role, messageId, value: body.value })'));
    assert.ok(read('netlify/functions/site-serve.ts').includes('waitlistOn: () => waitlistReady(db)'));
    assert.ok(team.includes("export type QuestionKey = 'start_now' | 'brief_video' | 'back_in_stock';") && team.includes("return sendResultWords(name, await sendBackInStock(db, { orgId: a.orgId, productId: a.ref }));"));
    assert.ok(read('src/components/assistant-shop.js').includes("post({ action: 'waitlist_send', productId: Number(waitSend.dataset.waitlistSend) })"));
    assert.ok(read('src/utils/shop-snapshot.ts').includes('WAITING LISTS ("Tell me when it\'s back"'));
    assert.ok(read('netlify/functions/purge-archived-assistants.ts').includes('await sweepWaitlist(db)'));
    const mod = read('src/utils/shop-waitlist.ts');
    assert.ok(mod.includes('(o.deps?.resolveRoute ?? resolveSendRoute)(db, o.orgId') && !/noreply@|bemoreswan\.com|fromLine\(/.test(mod), 'owner\'s route only');
    assert.ok(mod.includes('{ consentGivenHere: true }'), 'every refusal applies');
    assert.ok(!/audience_contacts|upsertContact/.test(mod), 'never adds anyone to the Audience');
});

check('the SQL: additive table, one waiting row per person per product; schema mirror; DB test in CI', () => {
    const m = read('db/z-shop-waitlist.sql');
    assert.ok(m.includes('CREATE TABLE IF NOT EXISTS shop_waitlist') && m.includes('ON shop_waitlist (product_id, lower(email)) WHERE notified_at IS NULL'));
    assert.ok(read('db/schema.ts').includes('export const shopWaitlist = pgTable("shop_waitlist"'));
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/shop-waitlist-db.test.ts'));
});

console.log(`\n${passed}/${total} passed`);
