// tests/meta-account-reach.test.ts
//
// Org 37, 2026-09-03: two posts in Needs Attention, and three separate pieces of code all telling
// the customer something false about why.
//
//   • Facebook said "(#200) The permission(s) publish_actions are not available. It has been
//     deprecated." We have never requested publish_actions. resolveFacebookPageCredentials fell
//     back to the raw USER token when the Page token could not be derived, and a user token POSTed
//     to /{pageId}/feed makes Meta guess at user-publishing and answer about a permission retired
//     in 2018. It reads as an App Review problem; the real cause was that the stored token had no
//     granted relationship to the Page.
//   • The connect flow could never have fixed it. The Business-portfolio scan was gated on
//     "nothing directly administered has an Instagram account linked" — and the owner of BOTH
//     accounts administered one personal Page that did. The scan was skipped, her business Pages
//     were never enumerated, and the picker offered the personal Page as the only option. Two
//     separate reconnects silently rebound the workspace to the wrong account.
//   • backfill-meta-vault-keys copied every "sole owner of its legacy key" row WITHOUT asking Meta
//     whether the token reached the account. The legacy writer overwrote, so a key is shared across
//     TIME as well as across rows: it blessed one account's token onto a key named after another
//     account's id, and left both rows looking perfectly healthy.
//
// These are source scans: the behaviours live in a Netlify handler and a CLI script, neither of
// which can be exercised without a live Meta grant. Each asserts on a UNIQUE string and never
// slices to a character window.
//
// Run:  npx tsx tests/meta-account-reach.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PUBLISH  = read('../src/utils/social-publish.ts');
const OAUTH    = read('../netlify/functions/meta-oauth.ts');
const BACKFILL = read('../scripts/backfill-meta-vault-keys.ts');

check('the Facebook resolver never falls back to the USER token', () => {
    // The exact expression that produced the publish_actions message.
    assert.ok(
        !PUBLISH.includes('derivePageToken(token, pageId) ?? token'),
        'the `?? token` fallback is back — a user token on /{pageId}/feed reports publish_actions, ' +
        'which sends the next reader to Meta App Review for a local problem',
    );
});

check('a underivable Page token throws, like the branch below it always did', () => {
    const i = PUBLISH.indexOf('export async function resolveFacebookPageCredentials');
    assert.notEqual(i, -1, 'resolveFacebookPageCredentials is gone or renamed');
    const fn = PUBLISH.slice(i, PUBLISH.indexOf('\n}', i));
    assert.ok(fn.includes('Could not obtain a Page access token'), 'the failure no longer names itself');
    // Both branches of this function must agree: neither may publish with an unverified token.
    assert.equal(
        (fn.match(/derivePageToken\(/g) ?? []).length, 2,
        'the two credential branches no longer both derive a Page token',
    );
});

check('the Business-portfolio scan is NOT gated on finding a linked Instagram account', () => {
    assert.ok(
        !OAUTH.includes('if (!pageList.some(p => p.instagram_business_account?.id)) {'),
        'the portfolio scan is gated again — one personal Page with an IG linked will hide every ' +
        'portfolio-owned Page the user has, and the picker will offer the wrong account alone',
    );
});

check('the portfolio scan still runs, and still merges into the same list', () => {
    assert.ok(OAUTH.includes('me/businesses?fields=id,name'), 'the portfolio enumeration is gone');
    for (const edge of ['owned_pages', 'client_pages']) {
        assert.ok(OAUTH.includes(edge), `the ${edge} edge is no longer scanned`);
    }
    assert.ok(OAUTH.includes('if (!seen.has(p.id)) { seen.add(p.id); pageList.push(p); }'),
        'portfolio Pages are no longer deduped into pageList');
});

check('the backfill verifies a sole-owner row before copying its secret', () => {
    assert.ok(
        BACKFILL.includes("entry.action === 'contested' || entry.action === 'migrate'"),
        "'migrate' rows are copied unverified again — 'sole owner of its legacy key' does not mean " +
        'the secret belongs to that row, because the legacy writer overwrote',
    );
});

check('the backfill still refuses to guess when Graph will not answer', () => {
    // The containment that stopped it reporting an app-level block as "reconnect" must survive:
    // widening verification to more rows widens the blast radius of a wrong verdict too.
    assert.ok(BACKFILL.includes("reach.kind === 'inconclusive'"), 'the inconclusive verdict is gone');
    assert.ok(BACKFILL.includes("reach.kind === 'token_dead'"), 'the dead-token verdict is gone');
});

console.log(`\n${passed} passed\n`);
