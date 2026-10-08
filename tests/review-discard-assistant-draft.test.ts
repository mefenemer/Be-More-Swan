// tests/review-discard-assistant-draft.test.ts
// An assistant's draft can be DISCARDED from the review modal, not only rejected.
//
// Reject is feedback: reject-post.ts saves the reason as a content rule (applyAsRule: true) and
// queues a replacement. A test post, a duplicate or a stale topic has nothing to teach, and
// rejecting it planted a junk rule and spent a task on an unwanted redraft (2026-10-08, a
// deployment-check post on prod). Discard soft-cancels it instead: no rule, no redraft.
// No network.
//
// Run:  npx tsx tests/review-discard-assistant-draft.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'workspace.html'), 'utf8');

const wrapStart = html.indexOf('<div id="post-review-when-reject-wrap"');
const wrap = html.slice(wrapStart, html.indexOf('</div>', html.indexOf('id="post-review-discard-btn"')));
const fnStart = html.indexOf('async function rqReviewDiscardDraft()');
const fn = html.slice(fnStart, html.indexOf('function closePostReview()', fnStart));

check('the Discard button sits in step 7, after Reject, for assistant drafts', () => {
    assert.ok(wrapStart > 0, 'reject wrap not found');
    assert.ok(wrap.includes('id="post-review-discard-btn" onclick="rqReviewDiscardDraft()"'));
    assert.ok(wrap.indexOf("rqReviewToggle('reject')") < wrap.indexOf('post-review-discard-btn'));
});
check('it says what it does NOT do', () => {
    assert.ok(wrap.includes('Nothing is learned and no replacement is written.'));
});
check('discard soft-cancels through scheduled-posts DELETE — never reject-post or approve-post', () => {
    assert.ok(fn.includes("fetch(`/.netlify/functions/scheduled-posts?id=${id}`, { method: 'DELETE' })"));
    assert.ok(!fn.includes('reject-post') && !fn.includes('approve-post'), 'discard must not create a rule');
});
check('the confirm for an assistant draft points to Reject for real feedback', () => {
    assert.ok(fn.includes('use Reject instead'));
    assert.ok(fn.includes("status === 'draft'"));
});
check('the server cancels anything unpublished (so a pending_approval draft can be discarded)', () => {
    const api = readFileSync(join(root, 'netlify/functions/scheduled-posts.ts'), 'utf8');
    const del = api.slice(api.indexOf("if (event.httpMethod === 'DELETE')"));
    assert.ok(del.includes("existing.status === 'published'"));
    assert.ok(del.includes("status: 'cancelled'"));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
