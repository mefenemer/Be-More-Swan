// tests/review-modal-when-defined.test.ts
// _rqReviewRenderActive (workspace.html) quotes `when` in its scheduled/approved and published
// status notes. Its definition sat beside the old subtitle line and went with it (b1f3a1f4,
// 2026-07-27), so from then on opening any scheduled, approved or published post threw
// "Can't find variable: when" — three red banners in the post editor, October 2026.
//
// Run:  npx tsx tests/review-modal-when-defined.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const html = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
const start = landmark(html, 'function _rqReviewRenderActive()');
const end = html.indexOf('\n}\n', start);
assert.ok(end > start, 'could not find the end of _rqReviewRenderActive — update this test');
const fn = html.slice(start, end);

console.log('\n_rqReviewRenderActive: `when` is declared before it is read\n');

test('`when` is declared in the function', () => {
    assert.match(fn, /\bconst when\s*=/, '`when` is read in the status notes but never declared');
});

test('the declaration comes before the first read', () => {
    const decl = fn.search(/\bconst when\s*=/);
    const firstRead = fn.search(/\$\{when \?/);
    assert.ok(firstRead > -1, 'the status notes no longer read `when` — update this test');
    assert.ok(decl > -1 && decl < firstRead, '`when` is read before it is declared (temporal dead zone)');
});

console.log(`\n${passed} checks passed`);
