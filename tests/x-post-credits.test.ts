// tests/x-post-credits.test.ts
// URL detection + cost for metered X posting (src/utils/ai-credits.ts).
//
// Run:  npx tsx tests/x-post-credits.test.ts
//
// This is cost-critical: a post "containing a link" costs 13× a text post (mirroring X's ~$0.20 vs
// ~$0.015 pricing), so a false negative under-charges the org's allowance and a false positive
// over-charges it. Pure logic — no DB required.

import assert from 'node:assert';
import { xPostHasLink, xPostCost, X_TEXT_COST, X_LINK_COST, X_CREDIT_PACKS, xCreditPack, xPackPrice, X_PACK_CURRENCIES } from '../src/utils/ai-credits';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('plain text is a text post (1 credit)', () => {
    assert.equal(xPostHasLink('Great chat with the team today! 🚀 #growth'), false);
    assert.equal(xPostCost('Great chat with the team today! 🚀 #growth'), X_TEXT_COST);
});

check('https:// and http:// links are detected', () => {
    assert.equal(xPostHasLink('New post up: https://bemoreswan.com/blog/x'), true);
    assert.equal(xPostHasLink('read http://example.org/a/b'), true);
    assert.equal(xPostCost('New post up: https://bemoreswan.com/blog/x'), X_LINK_COST);
});

check('www. and bare domains on common TLDs are links', () => {
    assert.equal(xPostHasLink('visit www.acme.io for more'), true);
    assert.equal(xPostHasLink('grab it at shop.example.store today'), true);
    assert.equal(xPostHasLink('details on bemoreswan.com'), true);
});

check('numbers, times and mentions are NOT links', () => {
    assert.equal(xPostHasLink('only $29.99 this week'), false);
    assert.equal(xPostHasLink('live at 8.30am sharp'), false);
    assert.equal(xPostHasLink('thanks @jane and @acme_co for the shoutout'), false);
});

check('a link anywhere in caption+hashtags triggers the link rate', () => {
    const text = ['Big news for our customers', '#launch #saas www.product.app'].join('\n\n');
    assert.equal(xPostHasLink(text), true);
    assert.equal(xPostCost(text), X_LINK_COST);
});

check('empty / nullish text is a text post, never throws', () => {
    assert.equal(xPostHasLink(''), false);
    assert.equal(xPostHasLink(undefined as unknown as string), false);
    assert.equal(xPostCost(''), X_TEXT_COST);
});

check('the link multiplier matches X pricing intent (~13×)', () => {
    assert.equal(X_TEXT_COST, 1);
    assert.equal(X_LINK_COST, 13);
});

check('booster packs are well-formed, multi-currency, and priced with margin over raw X cost', () => {
    assert.ok(X_CREDIT_PACKS.length >= 1, 'at least one pack');
    for (const p of X_CREDIT_PACKS) {
        assert.ok(p.id && p.credits > 0, `${p.id} well-formed`);
        // Every supported currency must be priced.
        for (const cur of X_PACK_CURRENCIES) {
            assert.ok(p.prices[cur] > 0, `${p.id} has a ${cur} price`);
        }
        // Raw X cost per credit ≈ £0.012 ($0.015). The GBP price must charge MORE than that (margin).
        const pencePerCredit = p.prices.gbp / p.credits;
        assert.ok(pencePerCredit > 1.2, `${p.id} priced above raw cost (${pencePerCredit.toFixed(2)}p/credit)`);
    }
    // Ids must be unique — they're the stable Stripe metadata key.
    assert.equal(new Set(X_CREDIT_PACKS.map(p => p.id)).size, X_CREDIT_PACKS.length, 'unique pack ids');
});

check('xCreditPack resolves known ids and rejects unknown ones', () => {
    assert.equal(xCreditPack('x_medium')?.credits, 1500);
    assert.equal(xCreditPack('nope'), undefined);
    assert.equal(xCreditPack(''), undefined);
});

check('xPackPrice returns the requested currency, falling back to GBP', () => {
    const pack = xCreditPack('x_medium')!;
    assert.deepEqual(xPackPrice(pack, 'USD'), { currency: 'usd', amountMinor: pack.prices.usd });
    assert.deepEqual(xPackPrice(pack, 'eur'), { currency: 'eur', amountMinor: pack.prices.eur });
    // Unknown / unsupported currency → GBP.
    assert.deepEqual(xPackPrice(pack, 'JPY'), { currency: 'gbp', amountMinor: pack.prices.gbp });
    assert.deepEqual(xPackPrice(pack, ''),    { currency: 'gbp', amountMinor: pack.prices.gbp });
});

console.log(`\n${passed} passed`);
