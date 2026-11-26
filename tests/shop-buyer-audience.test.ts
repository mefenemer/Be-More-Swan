// tests/shop-buyer-audience.test.ts
// Buyers who say yes join the Audience (online shop Phase 2, slice 4a; feature request #35, owner Q2 2026-11-26):
// src/utils/shop-buyer-audience.ts and where it is wired. The basket box itself: tests/shop-basket.test.ts.
//
// Run:  npx tsx tests/shop-buyer-audience.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buyerAudienceLine, newsBoxLabel, newsTicked, SHOP_BUYER_TAG } from '../src/utils/shop-buyer-audience';
import { shopTermsHtml, EMPTY_SHOP_SETTINGS } from '../src/utils/shop-settings';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('\nshop-buyer-audience');

check('only the exact ticked value counts; the box names the business', () => {
    assert.strictEqual(newsTicked({ bms_news: '1' }), true);
    for (const m of [{ bms_news: 'true' }, { bms_news: '' }, {}, null, undefined]) assert.strictEqual(newsTicked(m as never), false);
    assert.strictEqual(newsBoxLabel('Kudzu Candles'), 'Send me news and offers from Kudzu Candles by email. You can unsubscribe at any time.');
    assert.ok(newsBoxLabel('').includes('from this business'));
});

check('the owner\'s email says what happened, and never re-adds someone who unsubscribed', () => {
    assert.ok(buyerAudienceLine({ result: 'added', contactId: 1 })!.includes('joined your Audience'));
    assert.ok(buyerAudienceLine({ result: 'already', contactId: 1, status: 'subscribed' })!.includes('already in your Audience'));
    assert.ok(buyerAudienceLine({ result: 'already', contactId: 1, status: 'unsubscribed' })!.includes('were not added back'));
    assert.strictEqual(buyerAudienceLine({ result: 'no_email' }), null);
    assert.strictEqual(buyerAudienceLine(null), null);
});

check('added as single opt-in with the "Shop buyer" tag and a written consent record; refusals win (upsertContact)', () => {
    const mod = read('src/utils/shop-buyer-audience.ts');
    assert.strictEqual(SHOP_BUYER_TAG, 'Shop buyer');
    assert.ok(mod.includes("consentBasis: 'single_opt_in'") && mod.includes("source: 'web_form'") && mod.includes('sourceDetail: { siteOrderId: input.orderId }'));
    assert.ok(mod.includes('await applyTagsByName(db, input.organisationId, contact.id, [SHOP_BUYER_TAG]);') && mod.includes("event: 'confirmed'") && mod.includes('(unticked by default)'));
});

check('wired only after the order is PAID and recorded, from the ticked metadata; a failure never stops the order', () => {
    const shop = read('src/utils/site-shop.ts');
    const insert = shop.indexOf('.onConflictDoNothing({ target: siteOrders.checkoutSessionId }).returning();');
    const add = shop.indexOf('if (newsTicked(session.metadata as Record<string, string> | null)) {');
    assert.ok(insert > 0 && add > insert, 'after the order insert (a repeated webhook never gets here)');
    assert.ok(shop.includes("console.error('[site-shop] buyer → Audience failed'") && shop.includes("news: req.body.get('_news') === '1'"));
    assert.ok(shop.includes("${audienceLine ? `<p>${esc(audienceLine)}</p>` : ''}"));
});

check('the Delivery & returns page tells buyers what the box does', () => {
    assert.ok(shopTermsHtml({ ...EMPTY_SHOP_SETTINGS, traderName: 'Kudzu', contactEmail: 'a@b.c' }).includes('If you tick "Send me news" in your basket, your email address and name also join our mailing list'));
});

console.log(`\n${passed}/${total} passed`);
