// tests/blog-review-reject-seo-sections.test.ts
// Four Blog Writer review changes (2026-09-30):
//   1. No "Approve & Schedule" on a blog card — a post is approved AFTER it is read, in Blog Studio.
//   2. Reject a blog draft with a reason; the assistant learns from it (reject-blog-post.ts).
//   3. Every assistant-written blog draft arrives with SEO, visible in Blog Studio.
//   4. Blog Studio's left pane is titled, collapsible sections, like the social post editor's rail.
//
// Run:  npx tsx tests/blog-review-reject-seo-sections.test.ts

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
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const ws = read('workspace.html');
const as = read('assistants.js');
const bs = read('src/components/blog-studio-modal.js');
const reject = read('netlify/functions/reject-blog-post.ts');
const worker = read('netlify/functions/process-blog-jobs.ts');
const ideation = read('src/utils/blog-topic-ideation.ts');
const slice = (src: string, a: string, b: string) => {
    const i = src.indexOf(a); assert.notStrictEqual(i, -1, `marker gone: ${a}`);
    const j = src.indexOf(b, i); assert.notStrictEqual(j, -1, `marker gone: ${b}`);
    return src.slice(i, j);
};

// ── 1 ──
check('1. the Review page blog card cannot approve or schedule — it opens the post', () => {
    const card = slice(ws, 'function rqRenderBlogCard(', 'function _rqEsc(');
    assert.doesNotMatch(card, /schedule-blog|_rqApproveBlog|Approve/, 'no approval from the list');
    assert.match(card, /openBlogStudio\(\{postId:/);
    assert.doesNotMatch(ws, /function _rqApproveBlog/, 'the list-approve helper is gone');
});

check("1. the assistant tab's review column only offers Review in Blog Studio", () => {
    const actions = slice(as, 'function _rqBlogActions(', 'function _detailRqBlogCard(');
    const review = slice(actions, "if (statusKey === 'review') {", "} else if (statusKey === 'approved')");
    assert.match(review, /btn\('open', 'Review in Blog Studio'/);
    assert.doesNotMatch(review, /approveSchedule|showSchedule/);
});

// ── 2 ──
check('2. reject: only an undecided draft, conditional on its status, and a reason is required', () => {
    assert.match(reject, /const REJECTABLE = \['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'\]/);
    assert.match(reject, /if \(!feedback\) return json\(400/);
    assert.match(reject, /set\(\{ status: 'rejected'[\s\S]{0,200}eq\(blogPosts\.status, post\.status\)/,
        'a publish that raced the rejection must win');
});

check('2. reject teaches: a rejection_feedback rule plus a blueprint recompile', () => {
    assert.match(reject, /insert\(contentRules\)[\s\S]{0,300}origin: 'rejection_feedback'/);
    assert.match(reject, /assembleBlueprint\(post\.assistantId/, 'blog drafting reads rules from the COMPILED blueprint');
});

check('2. reject redrafts the slot only while it is ahead of us, carrying the reason', () => {
    assert.match(reject, /triggerType: 'scheduled',\s*contentType: 'blog',\s*targetPublishDate: post\.publishDate/);
    assert.match(reject, /contextPrompt: `A reviewer rejected an earlier draft/);
    assert.match(reject, /redraftSkippedReason = 'no_future_slot'/);
});

check('2. the reason steers the NEXT TOPIC, and rules reach ideation', () => {
    assert.match(worker, /guidance: job\.context_prompt/);
    assert.match(ideation, /Direction for THIS post — follow it/);
    assert.match(ideation, /buildBlueprintGuardrailsBlock\(db/);
});

check("2. Blog Studio: Reject only on an assistant's undecided draft; an empty reason is refused", () => {
    assert.match(bs, /post\.assistantId != null && post\.generationReason && REJECTABLE\.indexOf\(post\.status\) !== -1/);
    const go = slice(bs, "el('bs-reject-go').addEventListener", "// Search Console connect");
    assert.ok(go.indexOf("if (!reason)") < go.indexOf("api('reject-blog-post'"), 'validate before sending');
    assert.match(go, /feedbackText: reason,\s*applyAsRule: el\('bs-reject-rule'\)\.checked/);
});

// ── 3 ──
check('3. the worker writes SEO for EVERY assistant draft, interactive included', () => {
    const seo = slice(worker, 'Every assistant-written draft, interactive ones included', "status: 'completed', resultBlogPostId: targetPostId");
    assert.match(seo, /await generateBlogSeo\(db/);
    assert.doesNotMatch(seo, /if \(!interactive\)/);
});

check("3. Blog Studio shows it: after an AI draft, and on opening an assistant draft that has none", () => {
    assert.match(bs, /if \(!el\('bs-meta-title'\)\.value\.trim\(\) && !el\('bs-meta-desc'\)\.value\.trim\(\)\) populateSeo\(drafted\)/);
    const auto = slice(bs, 'function autoGenerateSeo(post)', 'function loadExistingPost(');
    assert.match(auto, /!post\.generationReason/, "only the assistant's drafts — never the author's own");
    assert.match(auto, /\(post\.metaTitle \|\| ''\)\.trim\(\) \|\| \(post\.metaDescription \|\| ''\)\.trim\(\)/, 'never overwrite existing SEO');
    assert.match(auto, /!el\('bs-meta-title'\)\.value\.trim\(\)/, 'never overwrite what the author typed meanwhile');
    assert.match(slice(bs, 'function loadExistingPost(', 'function renderSnippet'), /autoGenerateSeo\(post\)/);
    assert.match(read('netlify.toml'), /\[functions\.generate-seo\]\s*\n\s*timeout = 26/);
});

// ── 4 ──
check('4. the left pane is five titled, collapsible sections in working order', () => {
    const order = ['media', 'feature', 'columns', 'search', 'widget'];
    const at = order.map((k) => bs.indexOf(`<details class="bs-sec" data-bs-sec="${k}"`));
    at.forEach((i, n) => assert.notStrictEqual(i, -1, `section ${order[n]} missing`));
    assert.deepStrictEqual([...at].sort((a, b) => a - b), at, 'sections out of order');
    assert.match(bs, /data-bs-sec="media" open>/, 'the first section starts open');
    for (let n = 1; n <= 5; n++) assert.ok(bs.includes(`<span class="bs-sec-num">${n}</span>`), `badge ${n} missing`);
});

check('4. every control kept its id inside the right section', () => {
    const inSec = (k: string, next: string, id: string) =>
        assert.ok(slice(bs, `data-bs-sec="${k}"`, next).includes(`id="${id}"`), `${id} is not inside ${k}`);
    inSec('media', 'data-bs-sec="feature"', 'bs-media-library');
    inSec('feature', 'data-bs-sec="columns"', 'bs-feature-drop');
    inSec('columns', 'data-bs-sec="search"', 'bs-cols-2');
    inSec('search', 'data-bs-sec="widget"', 'bs-gsc-status');
    inSec('widget', 'bs-editor', 'bs-snippet');
});

// ── 5 (follow-up, 2026-09-30): SEO, destinations and publishing move into the left pane ──
check('5. SEO, "Where this post gets published" and "Approve & publish" are left-pane sections, in order', () => {
    const order = ['media', 'feature', 'columns', 'seo', 'where', 'publish', 'search', 'widget'];
    const at = order.map((k) => bs.indexOf(`<details class="bs-sec" data-bs-sec="${k}"`));
    at.forEach((i, n) => assert.notStrictEqual(i, -1, `section ${order[n]} missing`));
    assert.deepStrictEqual([...at].sort((a, b) => a - b), at, 'sections out of order');
    assert.ok(at[at.length - 1] < bs.indexOf('id="bs-editor"'), 'all eight must sit in the LEFT column, before the editor');
    for (let n = 1; n <= 8; n++) assert.ok(bs.includes(`<span class="bs-sec-num">${n}</span>`), `badge ${n} missing`);
    assert.match(bs, /data-bs-sec="publish" open>/, 'the publishing controls start open');
});

check('5. each control moved with its section, and Generate SEO sits with the SEO fields', () => {
    const sec = (k: string, next: string) => slice(bs, `data-bs-sec="${k}"`, next);
    assert.ok(sec('seo', 'data-bs-sec="where"').includes('id="bs-meta-title"'));
    assert.ok(sec('seo', 'data-bs-sec="where"').includes('id="bs-generate-seo"'));
    assert.ok(sec('where', 'data-bs-sec="publish"').includes('id="bs-dist-list"'));
    const pub = sec('publish', 'data-bs-sec="search"');
    for (const id of ['bs-approve', 'bs-publish', 'bs-reject', 'bs-reject-form', 'bs-schedule-picker', 'bs-discard']) {
        assert.ok(pub.includes(`id="${id}"`), `${id} is not in Approve & publish`);
    }
});

check("5. the action status stays in the right column, visible when its section is collapsed", () => {
    const right = bs.slice(bs.indexOf('id="bs-editor"'));
    assert.ok(right.includes('id="bs-action-status"'));
    assert.strictEqual(bs.split('id="bs-action-status"').length, 2, 'exactly one status banner');
});

check('5. on a narrow screen the two columns stack', () => {
    assert.match(bs, /@media \(max-width:860px\)\{\.bs-grid\{grid-template-columns:minmax\(0,1fr\);\}\}/);
});

// ── 6: the Review page refreshes after a change in Blog Studio ──
check('6. closing Blog Studio after a change refreshes the org-wide Review page list', () => {
    const hook = slice(as, 'window._onBlogStudioChanged = function', '\n};');
    assert.match(hook, /getElementById\('rq-groups'\)/);
    assert.match(hook, /window\.rqLoadItems\(\)/);
    assert.match(hook, /refreshPendingBadge/);
});

console.log(`\n${passed} checks passed`);
