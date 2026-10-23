// tests/review-bulk-remove.test.ts
// Tick several posts in an assistant's Review tab and Remove them together — and the chat's twin,
// a "remove" post_action_proposal.
//
// Remove is the editor's word (rqReviewDiscardDraft): a soft-cancel through scheduled-posts DELETE,
// so the posts land in Archived, nothing is learned and no replacement is written. The bulk path is
// one request (`?ids=`) for every platform row of every ticked card. No network.
//
// Run:  npx tsx tests/review-bulk-remove.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postActionFromUiElement } from '../src/utils/chat-post-action';
import { blogActionFromUiElement } from '../src/utils/chat-blog-action';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const api = read('netlify/functions/scheduled-posts.ts');
const bulk = api.slice(api.indexOf("if (event.httpMethod === 'DELETE' && qs.ids)"), api.indexOf("if (event.httpMethod === 'DELETE') {"));
const html = read('workspace.html');
const card = html.slice(html.indexOf('function rqRenderSocialCard('), html.indexOf('async function sdApprove('));
const js = read('assistants.js');

console.log('\nServer');
check('bulk DELETE soft-cancels, scoped to the user, and never touches what has gone out', () => {
    assert.ok(bulk.length > 0, 'bulk branch not found before the single DELETE');
    assert.ok(bulk.includes("status: 'cancelled'"));
    assert.ok(bulk.includes('eq(scheduledPosts.userId, userId)'));
    assert.ok(bulk.includes("NOT IN ('published', 'publishing', 'cancelled')"));
    assert.ok(bulk.includes('skippedIds'), 'rows it could not remove are reported, not a failed batch');
});

console.log('\nReview tab');
check('the card can carry a checkbox BESIDE its button, holding every platform row', () => {
    assert.ok(card.includes('opts.selectable'));
    assert.ok(card.includes("typeof opts === 'object'"), '.map() passes an index as the 2nd argument');
    assert.ok(card.includes('data-rq-ids="${ids}"'));
    assert.ok(card.indexOf('class="rq-select') < card.indexOf('${card}'), 'the input must sit outside the <button>');
});
check('only the Review column is selectable and gets the bar', () => {
    assert.match(js, /statusKey === 'review' \? \(d\) => rqRenderSocialCard\(d, \{ selectable: true \}\) : rqRenderSocialCard/);
    assert.match(js, /if \(statusKey !== 'review' \|\| groupKey !== 'posts'\) return '';/);
});
check('selection is cleared on every render pass', () => {
    const render = js.slice(js.indexOf('async function _detailRqRenderGroups('), js.indexOf('/** "Show more" under the list'));
    assert.ok(render.includes('_detailRqSelected.clear()'));
});
check('Remove confirms, uses the bulk path and says it teaches nothing', () => {
    const fn = js.slice(js.indexOf('window._detailRqRemoveSelected = async function()'), js.indexOf('function _detailRqGroupSection('));
    assert.ok(fn.includes('window.confirmModal('));
    assert.ok(fn.includes("${blog ? 'blog-posts' : 'scheduled-posts'}?ids=${ids.join(',')}`, { method: 'DELETE' }"));
    assert.ok(fn.includes('Reject and redraft instead'));
    assert.ok(!fn.includes('reject-post'), 'Remove must not create a rule');
});
check('the checkbox handler is bound to the document, not from a render path', () => {
    assert.match(js, /document\.addEventListener\('change', \(e\) => \{\s*const t = e\.target;\s*if \(!\(t instanceof HTMLInputElement\) \|\| !t\.closest\('#detail-rq-groups'\)\) return;/);
});

console.log('\nChat');
check('remove is a post action, and needs no reason or time', () => {
    const r = postActionFromUiElement({ type: 'post_action_proposal', action: 'remove', postId: '#12', reason: 'x', when: 'y' });
    assert.deepStrictEqual(r, { action: 'remove', postId: 12, reason: null, when: null });
});
check('the click calls the same bulk path as the tab', () => {
    const cs = read('src/components/chat-session.js');
    const h = cs.slice(cs.indexOf('async function onPostAction('), cs.indexOf('// Mystery Shopper cards'));
    assert.ok(h.includes("d.action === 'remove'"));
    assert.ok(h.includes("scheduled-posts?ids=${ids.join(',')}`, { method: 'DELETE'"));
});
check('the card and the prompt both know remove', () => {
    assert.match(read('src/components/disruptive-ui-registry.js'), /remove: \{ head: 'Remove this post', button: 'Remove', busy: 'Removing…' \}/);
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(o.includes('"approve" | "reject" | "retry" | "reschedule" | "remove"'));
    assert.ok(o.includes('remove one they simply don\'t want'));
});

console.log('\nBlog drafts (Blog Writer Review tab)');
const blogApi = read('netlify/functions/blog-posts.ts');
const blogBulk = blogApi.slice(blogApi.indexOf("if (event.httpMethod === 'DELETE' && event.queryStringParameters?.ids)"), blogApi.indexOf("if (event.httpMethod === 'DELETE') {"));
check('bulk blog DELETE archives, org-scoped, and never touches a live article', () => {
    assert.ok(blogBulk.length > 0, 'bulk branch not found before the single DELETE');
    assert.ok(blogBulk.includes("status: 'archived'"));
    assert.ok(blogBulk.includes('eq(blogPosts.organisationId, ctx.organisationId)'));
    assert.ok(blogBulk.includes("NOT IN ('published', 'publishing', 'archived')"));
    assert.ok(blogBulk.includes('skippedIds'));
});
check('blog Review cards carry a checkbox and the same bar; selection clears on render', () => {
    const cardFn = js.slice(js.indexOf('function _detailRqBlogCard('), js.indexOf('// ── Newsletter issues in the Review Queue'));
    assert.ok(cardFn.includes("statusKey === 'review'") && cardFn.includes('class="rq-select'));
    const render = js.slice(js.indexOf('async function _detailRqRenderBlog('), js.indexOf('window._detailRqBlogAct = async function'));
    assert.ok(render.includes('_detailRqSelected.clear()'));
    assert.ok(render.includes("_detailRqBulkBar(statusKey, 'posts')"));
});
check('Remove picks the blog endpoint for a blog queue and forgets the cached list', () => {
    const fn = js.slice(js.indexOf('window._detailRqRemoveSelected = async function()'), js.indexOf('function _detailRqGroupSection('));
    assert.ok(fn.includes("${blog ? 'blog-posts' : 'scheduled-posts'}?ids="));
    assert.ok(fn.includes('if (blog) _forgetBlogPosts();'));
    assert.ok(!fn.includes('reject-blog-post'), 'Remove must not create a rule');
});
check('the blog chat can propose remove, through the same endpoint', () => {
    assert.deepStrictEqual(blogActionFromUiElement({ type: 'blog_action_proposal', action: 'remove', postId: 8, reason: 'x', when: 'y' }),
        { action: 'remove', postId: 8, reason: null, when: null });
    const cs = read('src/components/chat-session.js');
    const h = cs.slice(cs.indexOf('async function onBlogAction('));
    assert.ok(h.includes("blog-posts?ids=${d.postId}`, { method: 'DELETE'"));
    assert.match(read('src/components/disruptive-ui-registry.js'), /remove: \{ head: 'Remove this article', button: 'Remove', busy: 'Removing…' \}/);
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"approve" | "schedule" | "unschedule" | "reject" | "remove"'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
