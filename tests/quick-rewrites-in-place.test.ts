// tests/quick-rewrites-in-place.test.ts
// Step 1's quick rewrites (tone / hashtags / grammar) must edit the post IN PLACE.
//
// They used to fill the feedback box and press Regenerate. That reads like sharing code; it is not.
// request-post-changes CANCELS the draft (status 'cancelled') and queues a job that generates a
// REPLACEMENT post with a new id — so "suggest hashtags" threw the post away, redrafted the whole
// thing from the blueprint, and handed the user back to the Review Queue to wait for something else
// to arrive. That is the bug. The free-text "Regenerate" box still uses it, correctly, because
// there a redraft IS the request.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
const fn = readFileSync(path.join(ROOT, 'netlify/functions/rewrite-post-text.ts'), 'utf8');
const rewrite = ws.slice(ws.indexOf('async function _railRewrite(action, tone) {'));
const body = rewrite.slice(0, rewrite.indexOf('\n}\n'));

console.log('\nquick rewrites edit in place\n');

check('the quick actions no longer cancel the draft', () => {
    assert.ok(!/rqReviewRequestChanges\(\)/.test(body),
        'request-post-changes cancels the post and queues a replacement — that is not "suggest hashtags"');
    assert.match(body, /rewrite-post-text/, 'they call the targeted endpoint instead');
    // Nothing in the quick path may take the user out of the editor.
    for (const exit of ['_rqReviewRefresh', 'rqReviewShowRegenerating', 'rqReviewToggle']) {
        assert.ok(!new RegExp(exit).test(body), `${exit} would navigate away from the post being edited`);
    }
});

check('the free-text Regenerate box still redrafts', () => {
    // The distinction is the point: one asks for different words, the other asks for a different post.
    const req = ws.slice(ws.indexOf('async function rqReviewRequestChanges()'));
    assert.match(req.slice(0, 2000), /request-post-changes/, 'a genuine redraft still uses the job pipeline');
});

check('each action may only touch its own field', () => {
    // "Suggest hashtags" rewriting the caption behind the user is the worst version of this feature.
    assert.match(fn, /const FIELD: Record<Action, 'caption' \| 'hashtags'> = \{/, 'the mapping is explicit');
    assert.match(fn, /tone: 'caption', grammar: 'caption', hashtags: 'hashtags'/, 'and hashtags is hashtags only');
    assert.match(fn, /text\.match\(\/#\[\\p\{L\}\\p\{N\}_\]\+\/gu\)/,
        'a model that prefixes a sentence would otherwise save that sentence into the hashtags field');
});

check('an over-limit rewrite warns instead of truncating mid-word', () => {
    assert.match(fn, /overLimit: text\.length > limit/, 'the server reports it');
    // The source escapes the apostrophe inside a JS string literal, hence the \\'? here.
    assert.match(body, /over this platform\\?'s limit — trim it before approving/, 'and the editor says so');
});

check('it is metered, tenant-guarded, and refuses an empty caption first', () => {
    const guardAt = fn.indexOf('eq(scheduledPosts.organisationId, ctx.organisationId)');
    const emptyAt = fn.indexOf("if (!caption.trim())");
    const spendAt = fn.indexOf('await consumeTaskCredit(');
    assert.ok(guardAt > 0 && guardAt < spendAt, 'prove ownership before billing a workspace');
    assert.ok(emptyAt > 0 && emptyAt < spendAt, 'refuse an empty caption before spending a credit on an apology');
    assert.match(fn, /if \(credit\.failed\) return json\(503/, 'an outage must not be reported as a plan limit');
});

check('the caption path repaints the canvas and the length badges', () => {
    // Setting .value in script fires no input event, so neither updates on its own — and the badges
    // are what stop an over-limit post being approved.
    assert.match(body, /_pceRefreshCaptionMeta\(\)/, 'the per-platform length badges are driven by the caption');
    assert.match(body, /_rqReviewRenderActive\(\)/, 'the caption is on the canvas too');
});

check('the buttons re-enable even when the call throws', () => {
    assert.match(body, /finally \{/, 'a failed rewrite must not leave step 1 permanently disabled');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
