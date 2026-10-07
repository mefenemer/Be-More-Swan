// tests/promote-ci-gate.test.ts
// The "Push to prod" lane (scripts/dev-issue-fixer.mjs processPromote) promotes through a PR and
// merges only when CI passes: scripts/promote-ci-verdict.mjs decides.
//
// Since 2026-10-07 main's ruleset requires these checks and rejects direct pushes, so the lane must
// never push to main again, and its check names must match ci.yml or it waits forever.
// No network.
//
// Run:  npx tsx tests/promote-ci-gate.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore — plain .mjs module, no types
import { REQUIRED_CHECKS, promoteCiVerdict } from '../scripts/promote-ci-verdict.mjs';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const row = (name: string, bucket: string) => ({ name, bucket });
const T = 'Typecheck + tests', R = 'RLS tenant-isolation (Postgres)';

console.log('promoteCiVerdict');
check('both required checks passing (twice each, push + PR) → pass; other checks are ignored', () =>
    assert.deepEqual(promoteCiVerdict([row(T, 'pass'), row(R, 'pass'), row(T, 'pass'), row(R, 'pass'), row('netlify/x', 'fail')]), { state: 'pass' }));
check('one copy still running → pending', () =>
    assert.equal(promoteCiVerdict([row(T, 'pass'), row(T, 'pending'), row(R, 'pass')]).state, 'pending'));
check('a required check not reported yet → pending (just after the PR is opened)', () =>
    assert.deepEqual(promoteCiVerdict([row(T, 'pass')]), { state: 'pending', check: R }));
check('no checks at all → pending, never pass', () => assert.equal(promoteCiVerdict([]).state, 'pending'));
check('any failing copy → fail, even while the other runs', () =>
    assert.deepEqual(promoteCiVerdict([row(T, 'fail'), row(T, 'pass'), row(R, 'pending')]), { state: 'fail', check: T }));
check('a cancelled run counts as a failure', () => assert.equal(promoteCiVerdict([row(T, 'pass'), row(R, 'cancel')]).state, 'fail'));
check('garbage input does not throw', () => assert.equal(promoteCiVerdict(null as any).state, 'pending'));

console.log('wiring');
check('REQUIRED_CHECKS are exactly ci.yml job names', () => {
    const yml = read('.github/workflows/ci.yml');
    for (const name of REQUIRED_CHECKS) assert.ok(yml.includes(`name: ${name}`), `ci.yml has no job named "${name}"`);
});
check('the promote lane never pushes to the prod branch', () => {
    const src = read('scripts/dev-issue-fixer.mjs');
    const fn = src.slice(src.indexOf('async function processPromote('), src.indexOf('// Investigate a failed merge:'));
    assert.ok(!/git\(\['push'/.test(fn), 'processPromote must not git push');
    assert.ok(fn.includes("'pr', 'create'") && fn.includes("'pr', 'merge', pr, '--merge'"));
    assert.ok(fn.indexOf("verdict.state === 'fail'") < fn.indexOf("'pr', 'merge', pr"), 'merge must come after the CI verdict');
    assert.ok(!fn.includes('--auto'), 'no auto-merge: it would report success before prod changed');
});
check('the wait is async (sleep), so the runner heartbeat keeps firing', () => {
    const src = read('scripts/dev-issue-fixer.mjs');
    const fn = src.slice(src.indexOf('async function processPromote('), src.indexOf('// Investigate a failed merge:'));
    assert.ok(fn.includes('await sleep(PROMOTE_POLL_MS)'));
    assert.ok(!fn.includes('--watch'), 'gh --watch under spawnSync would freeze the event loop');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
