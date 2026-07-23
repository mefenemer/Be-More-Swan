// tests/x-post-credits.test.ts
// URL detection + cost for metered X posting (src/utils/ai-credits.ts).
//
// Run:  npx tsx tests/x-post-credits.test.ts
//
// This is cost-critical: a post "containing a link" costs 13× a text post (mirroring X's ~$0.20 vs
// ~$0.015 pricing), so a false negative under-charges the org's allowance and a false positive
// over-charges it. Pure logic — no DB required.

import assert from 'node:assert';
import { xPostHasLink, xPostCost, X_TEXT_COST, X_LINK_COST } from '../src/utils/ai-credits';

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

console.log(`\n${passed} passed`);
