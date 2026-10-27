// tests/bubbles-images-blog-approve.test.ts
// Owner's list, 2026-10-27:
//   1. Assistant pop-up bubbles sat bottom-left at z-index 60; a page opened while one showed drew over
//      it. They now sit under the header's assistant switcher, above everything.
//   2. The blog's four AI images were near-copies: one prompt drawn four times only changes the seed.
//      Now four different interpretations, one image each.
//   3. Blog Studio approve: the same words as the social Review, and after approving, the next draft
//      waiting is one click away ("Next: …"), as in the social Review.
//
// Run:  npx tsx tests/bubbles-images-blog-approve.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fillPrompts, FALLBACK_FRAMINGS, parsePromptList, VARIANTS_TIMEOUT_MS } from '../src/lib/image-prompt';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

console.log('bubbles, AI image variety, blog approve');

// ── 1. Bubbles ───────────────────────────────────────────────────────────────────────────────────
const bubbles = read('src/components/assistant-bubbles.js');

function loadBubbles() {
    const win: any = {};
    vm.runInNewContext(bubbles, { window: win, document: { getElementById: () => null }, requestAnimationFrame: () => 0, setTimeout, clearTimeout, fetch: () => Promise.reject() });
    return win.AssistantBubbles;
}

test('bubbles sit under the assistant switcher, right edges aligned', () => {
    const { _anchorFor } = loadBubbles();
    assert.deepEqual(_anchorFor({ bottom: 56, right: 1200, width: 36 }, 1280), { top: 64, right: 80 });
    assert.deepEqual(_anchorFor({ bottom: 56, right: 1278, width: 36 }, 1280), { top: 64, right: 16 }, 'never closer than 16px to the edge');
    assert.deepEqual(_anchorFor(null, 390), { top: 72, right: 16 }, 'no switcher (phone): top-right under the header');
    assert.deepEqual(_anchorFor({ bottom: 0, right: 0, width: 0 }, 390), { top: 72, right: 16 }, 'a hidden switcher measures 0');
});

test('bubbles are above everything, and stay the last thing on the page', () => {
    assert.match(bubbles, /const TOP_Z = 2147483000;/);
    assert.match(bubbles, /position:fixed;z-index:\$\{TOP_Z\}/);
    assert.doesNotMatch(bubbles, /left:16px;bottom:16px/);
    assert.match(bubbles, /if \(h !== document\.body\.lastElementChild\) document\.body\.appendChild\(h\);/);
    assert.match(bubbles, /getElementById\('nav-assistant-switcher-btn'\)/);
    assert.match(read('workspace.html'), /id="nav-assistant-switcher-btn"/);
});

// ── 2. Four different images ─────────────────────────────────────────────────────────────────────
test('the model\'s four prompts are read from its reply', () => {
    const four = ['A wide shot of a busy workshop at dawn, workers arriving', 'Close-up of two hands passing a key across a desk, soft light', 'An empty office chair beside a running coffee machine, morning', 'A relay baton mid-handover on a sunlit track, low angle'];
    assert.deepEqual(parsePromptList(`Here you go:\n${JSON.stringify(four)}`, 4), four);
    assert.deepEqual(parsePromptList('not json', 4), []);
    assert.deepEqual(parsePromptList('["too short", 3]', 4), []);
});

test('there are always four prompts, and never four identical ones', () => {
    const base = 'A florist arranging flowers in a bright shop, photographic';
    const filled = fillPrompts([], base, 4);
    assert.equal(filled.length, 4);
    assert.equal(new Set(filled).size, 4, 'each gets a different framing');
    filled.forEach((p, i) => assert.ok(p.startsWith(base) && p.endsWith(FALLBACK_FRAMINGS[i])));
    const two = fillPrompts(['First idea, a wide scene of the shop', 'Second idea, a close-up of a bouquet'], base, 4);
    assert.equal(two[0], 'First idea, a wide scene of the shop');
    assert.equal(new Set(two).size, 4);
});

test('generate-ai-image draws one image per interpretation, inside the function budget', () => {
    const fn = read('netlify/functions/generate-ai-image.ts');
    assert.match(fn, /generateImageVariants\(\{ prompts: await visualisePrompts\(prompt, 4,/);
    assert.match(fn, /timeoutMs: 18_000/);
    assert.ok(VARIANTS_TIMEOUT_MS + 18_000 <= 26_000, 'rewrite + images under the 26s function timeout');
    const fal = read('src/lib/fal-gateway.ts');
    assert.match(fal, /prompts\.slice\(0, 4\)\.map\(\(prompt\) => generateImages\(\{ \.\.\.rest, prompt, numImages: 1 \}\)\)/);
    assert.match(fal, /Promise\.allSettled/);
    assert.match(read('src/lib/image-prompt.ts'), /genuinely DIFFERENT interpretations/);
});

// ── 3. Blog Studio approve ───────────────────────────────────────────────────────────────────────
const studio = read('src/components/blog-studio-modal.js');

test('Blog Studio uses the social Review\'s words', () => {
    assert.match(studio, /picks the next free slot<\/span><\/button>/);
    assert.match(studio, /id="bs-pick-time" class="bs-btn bs-btn-ghost">Pick the time myself</);
    assert.match(studio, /id="bs-decide-time" class="bs-btn bs-btn-ghost">Pick the time myself</);
    assert.doesNotMatch(studio, /picks the time<\/span>|>Pick a time myself<|>Pick a time</);
    // the social wording it matches
    const ws = read('workspace.html');
    assert.match(ws, /picks the next free slot/);
    assert.match(ws, /Pick the time myself/);
});

test('after approving, the next draft waiting is offered, as in the social Review', () => {
    const approve = studio.slice(studio.indexOf("el('bs-approve').addEventListener('click'"), studio.indexOf("el('bs-schedule').addEventListener('click'"));
    assert.match(approve, /notifyChanged\(\);[^\n]*\n\s*showApproved\(res\.body\.post\);/);
    assert.match(studio, /id="bs-approved" class="bs-decide bs-hidden" role="status"/);
    assert.match(studio, /openBlogStudio\(\{ assistantId: aid, postId: id, intent: 'review' \}\)/);
    assert.match(studio, /That was the last article waiting\./);
    assert.match(studio, /state\.nextPostId = null;\n\s*el\('bs-approved'\)\.classList\.add\('bs-hidden'\);/);
});

test('"next" is the soonest slot still waiting, the approved one left out', () => {
    const src = studio.slice(studio.indexOf('  var REVIEW_STATUSES'), studio.indexOf('  // "✓ Approved'));
    const ctx: any = {};
    vm.runInNewContext(`${src}\nthis.waitingAfter = waitingAfter;`, ctx);
    const posts = [
        { id: 1, status: 'pending_approval', publishDate: '2026-11-05T09:00:00Z' },
        { id: 2, status: 'scheduled', publishDate: '2026-10-28T09:00:00Z' },
        { id: 3, status: 'pending_approval', publishDate: '2026-10-30T09:00:00Z' },
        { id: 4, status: 'draft', publishDate: null },
        { id: 5, status: 'draft', publishDate: null, writtenByAssistant: false },
        { id: 6, status: 'in_review', publishDate: '2026-10-29T09:00:00Z' },
    ];
    assert.deepEqual(ctx.waitingAfter(posts, 6).map((p: any) => p.id), [3, 1, 4]);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
