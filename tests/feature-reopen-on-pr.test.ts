// tests/feature-reopen-on-pr.test.ts
// A Released feature request that gets another PR (its next phase) must go back to In progress, so the
// live check can release it again once production contains the new PR.
//
// What went wrong (FR#43 Phase 2, 2026-11-16): `feature-requests.ts pr` cleared live_at for the new PR
// but left the request Released. runFeatureLiveCheck only looks at requests that are NOT Released, so
// the checklist said "Live on production: Not in main yet" for ever, though the deploy contained it.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const script = read('scripts/feature-requests.ts');
const prStart = script.indexOf("} else if (cmd === 'pr') {");
const prEnd = script.indexOf("} else if (cmd === 'staging-sql') {");
const prBlock = script.slice(prStart, prEnd);

check('the pr command is found', () => {
    assert.ok(prStart > 0 && prEnd > prStart);
});

check('a new PR clears live_at AND reopens a Released request in the same update', () => {
    const upd = prBlock.slice(prBlock.indexOf('UPDATE feature_requests SET dev_sql'));
    const end = upd.indexOf('WHERE id = ${id}');
    const set = upd.slice(0, end);
    assert.ok(set.includes('live_at = NULL'), 'live_at is cleared');
    assert.ok(set.includes("status = CASE WHEN status = 'released' THEN 'in_progress' ELSE status END"), 'Released → In progress');
});

check('only Released is reopened — declined and duplicate keep their status', () => {
    assert.ok(!/WHEN status = '(declined|duplicate)'/.test(prBlock));
});

check('the reopen is noted on the request and says no one was notified', () => {
    assert.ok(prBlock.includes("reopened = was[0]?.status === 'released'"));
    assert.ok(/if \(reopened\) \{\s*await note\('Reopened:[^']*No one was notified\.'\)/.test(prBlock));
});

check('the live check still releases only requests that are not Released — which is why the reopen is needed', () => {
    const live = read('src/utils/feature-proof.ts');
    const at = live.indexOf('export async function runFeatureLiveCheck');
    const body = live.slice(at);
    assert.ok(body.includes("WHERE live_at IS NULL AND status NOT IN ('released', 'declined', 'duplicate')"));
});

console.log(`\n${passed} checks passed.`);
