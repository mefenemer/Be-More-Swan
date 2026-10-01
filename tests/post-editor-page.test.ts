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

console.log(`\n${passed} checks passed.`);
