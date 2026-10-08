// tests/quality-review-failure-paths.test.ts
// Two ways a failed quality review used to take a post's decisions down with it (prod, 2026-10-08):
//   1. the reviewer fenced its JSON (```json … ```) and a bare JSON.parse turned a good verdict
//      into a 502 — src/utils/post-quality-review.ts must use parseModelJson;
//   2. the step rail was only redrawn on SUCCESS, so a failure left "Write a caption first" on
//      Check & improve and Schedule & publish — hiding Approve, Reject and Discard.
// No network.
//
// Run:  npx tsx tests/quality-review-failure-paths.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModelJson } from '../src/utils/model-json';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

check('a fenced verdict (the real prod reply shape) parses', () => {
    const raw = '```json\n{\n  "brandVoiceScore": 72,\n  "complianceWarnings": ["Rule 4 breach: posts automatically"]\n}\n```';
    const v = parseModelJson<{ brandVoiceScore: number; complianceWarnings: string[] }>(raw)!;
    assert.equal(v.brandVoiceScore, 72);
    assert.equal(v.complianceWarnings.length, 1);
});
check('the review uses parseModelJson, never a bare JSON.parse of the model text', () => {
    const src = read('src/utils/post-quality-review.ts');
    assert.ok(src.includes('parseModelJson<ReviewJson>(gwResponse.text)'));
    assert.ok(!src.includes('JSON.parse(gwResponse.text)'));
});
check('both failure exits of the review loader redraw the rail', () => {
    const html = read('workspace.html');
    const start = html.indexOf("const res = await fetch('/.netlify/functions/review-post-quality', {\n            method: 'POST', headers: { 'Content-Type': 'application/json' },\n            body: JSON.stringify({ postId }),");
    assert.ok(start > 0, 'review loader not found');
    const block = html.slice(start, html.indexOf('data = await res.json();', start) + 200);
    assert.equal(block.match(/_prqRedrawRailAfterFailure\(postId\)/g)?.length, 2, 'the !res.ok path AND the catch must both redraw');
});
check('the redraw is guarded against a different post having been opened', () => {
    const html = read('workspace.html');
    const fn = html.slice(html.indexOf('function _prqRedrawRailAfterFailure(postId)'));
    assert.ok(fn.slice(0, 200).includes('if (_prqPostId !== postId) return;'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
