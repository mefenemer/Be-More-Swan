// tests/review-group-counts.test.ts
// The count pill beside a Review group ("Social media posts") must agree with the tab badge above it.
//
// Reported 2026-09-30 on PROD: the Review tab said 59 while the group pill said 10 — the pill counted
// the cards loaded so far (one page of 10), the tab counted the whole column, and nothing on screen
// explained the gap. Now: "10 of 59" while paged, "59" once everything is loaded, on BOTH the
// org-wide Review page (workspace.html) and the assistant's own review tab (assistants.js).
//
// Run:  npx tsx tests/review-group-counts.test.ts

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

/** Pull a top-level `function name(...) {...}` out of a source file and make it callable. */
function extract(src: string, name: string): (...a: unknown[]) => unknown {
    const start = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `${name} is gone — update this test`);
    const end = src.indexOf('\n}\n', start);
    return new Function(`${src.slice(start, end + 2)}; return ${name};`)();
}

check('the label reads "N of M" while paged and "M" when complete', () => {
    const label = extract(ws, 'rqGroupCountLabel');
    assert.strictEqual(label(10, 59), '10 of 59');
    assert.strictEqual(label(20, 59), '20 of 59');
    assert.strictEqual(label(59, 59), '59');
    assert.strictEqual(label(3, undefined), '3', 'no server total (blog group, older server) → the loaded count');
    assert.strictEqual(label(0, 0), '0');
});

check("the assistant tab's fallback agrees with the shared rule", () => {
    const fallback = extract(as, '_detailRqCountLabel');
    // rqGroupCountLabel is absent in this sandbox, so this exercises the fallback branch.
    assert.strictEqual(fallback(10, 59), '10 of 59');
    assert.strictEqual(fallback(59, 59), '59');
});

check('both group pills render the label, never a bare items.length', () => {
    assert.match(ws, /class="rq-group-count[^"]*">\$\{rqGroupCountLabel\(items\.length, total\)\}/);
    assert.match(as, /class="rq-group-count[^"]*">\$\{_detailRqCountLabel\(items\.length, total\)\}/);
});

check('the posts group is handed the SERVER total, on first paint and after "Show more"', () => {
    assert.match(ws, /posts: _rqPostsTotal \?\? postGroups\.length/);
    assert.match(ws, /rqGroupCountLabel\(groups\.length, _rqPostsTotal\)/);
    assert.match(as, /statusKey, _detailRqTotal \?\? postGroups\.length\)/);
    assert.match(as, /_detailRqCountLabel\(groups\.length, _detailRqTotal\)/);
});

check('the org-wide Review tab counts every group under it, blog drafts included', () => {
    assert.match(ws, /const tabCount = pending \+ \(_rqBlogWriterActive \? blogPosts\.length : 0\)/);
    assert.match(ws, /rq-col-count-review'\);\s*\n\s*if \(badge\) \{ badge\.textContent = tabCount/);
});

console.log(`\n${passed} checks passed`);
