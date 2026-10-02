// tests/post-editor-page.test.ts
// The social post editor as a PAGE (not a pop-up), and the quality review that greeted a brand-new,
// empty post with "could not be completed" (both reported 2026-10-01).

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const W = read('workspace.html');
const Q = read('netlify/functions/review-post-quality.ts');

check('an empty post is not a failed review', () => {
    assert.ok(landmark(Q, "if (!String(post.caption ?? '').trim())") < landmark(Q, 'runQualityReview(db'), 'answered before the model is asked');
    assert.match(Q, /JSON\.stringify\(\{ empty: true \}\)/);
    assert.match(W, /if \(data && data\.empty\) \{ _prqShow\('prq-loading', false\); wrap\.classList\.add\('hidden'\); return; \}/);
});

check('the editor is laid out as a page beside the sidebar and under the header', () => {
    assert.match(W, /<div id="post-review-modal" class="pr-page /);
    assert.match(W, /#post-review-modal\.pr-page \{ top: 64px; left: 0;/);
    assert.match(W, /@media \(min-width: 768px\) \{ #post-review-modal\.pr-page \{ left: 16rem; \} \}/);
});

check('it has breadcrumbs back, and leaving for another page closes it', () => {
    assert.match(W, /<nav id="post-review-crumbs"/);
    assert.match(W, /_rqRenderPostCrumbs\(post\);/);
    const lv = W.slice(landmark(W, 'async function loadView(routeKey, param = null) {'));
    assert.match(lv.slice(0, 900), /if \(postEditor && !postEditor\.classList\.contains\('hidden'\) && typeof closePostReview === 'function'\) closePostReview\(\);/);
});

const BS = read('src/components/blog-studio-modal.js');
const EP = read('netlify/functions/assistant-enabled-platforms.ts');

check('the new-post picker offers only the platforms switched on for the assistant', () => {
    assert.match(EP, /resolveAssistantEnabledPlatforms\(db, \{/, 'the SAME server rule drafting uses — not a client copy');
    assert.match(EP, /eq\(aiAssistants\.organisationId, ctx\.organisationId\)/);
    assert.match(EP, /enabled: enabled \? \[\.\.\.enabled\] : null/, 'null = no selection recorded = show everything');
    const open = W.slice(landmark(W, 'async function pceOpenDestinationsForCreate'), landmark(W, 'function rqReviewAddDestination') - 10);
    assert.match(open, /await _pceLoadEnabledPlatforms\(assistantId\)/);
    const render = W.slice(landmark(W, 'function _pceRenderDestinations()'), landmark(W, 'function _pceFormatSpecLine'));
    assert.match(render, /!_pceDestEnabled \|\| _pceDestEnabled\.has\(p\.id\)/);
});

check('the editor can go back to the platform & format picker', () => {
    assert.match(W, /id="pce-change-dest" onclick="rqReviewAddDestination\(\)"/);
    assert.match(W, /const can = group\.length > 0 && _rqCanEditDestinations\(group\);/, 'same rule as the tab strip');
});

check('as a page the preview is drawn bigger, by the same scaling', () => {
    assert.match(W, /const _PCE_PAGE_MAX_VH = 0\.74;/);
    assert.match(W, /const _PCE_PAGE_CARD_MAX_PX = 600;/);
    assert.match(W, /#post-review-modal\.pr-page \[data-mockup-card\],/);
});

check('the Blog Studio is a page inside the workspace, with breadcrumbs, and closes on navigation', () => {
    assert.match(BS, /#bms-blog-backdrop\.bs-page\{top:64px;left:0;/);
    assert.match(BS, /var inWorkspace = !!document\.getElementById\('sidebar-container'\);/, 'standalone blog-studio.html keeps the pop-up');
    assert.match(BS, /<nav id="bs-crumbs"/);
    assert.match(W, /if \(document\.getElementById\('bms-blog-backdrop'\)\?\.classList\.contains\('bs-open'\)\) window\.closeBlogStudio\?\.\(\);/);
});

console.log(`\n${passed} checks passed.`);
