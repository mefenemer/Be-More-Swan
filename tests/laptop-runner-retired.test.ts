// tests/laptop-runner-retired.test.ts
// The laptop runner (scripts/dev-issue-fixer.mjs + its machine endpoint admin-issue-handoff.ts,
// authenticated by the shared DEV_HANDOFF_TOKEN) was retired on 2026-11-12. Fixes and merges run in
// GitHub Actions; a failed merge is redone by the AI fix workflow; "Open hotfix PR" replaced "Push
// to prod". Pins: the runner and its endpoint are gone, nothing sets its queued states, leftovers
// from it can be started again (so nothing is stranded even before the clean-up SQL runs), and the
// optional SQL only touches laptop-held rows.

import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('laptop runner retired');

check('the runner, its service files and its machine endpoint are gone', () => {
    for (const f of [
        'scripts/dev-issue-fixer.mjs', 'scripts/dev-issue-fixer-service.sh', 'scripts/dev-issue-fixer.env.example',
        'scripts/dev-issue-fixer.md', 'scripts/com.aura.issue-fixer.plist', 'scripts/promote-ci-verdict.mjs',
        'netlify/functions/admin-issue-handoff.ts', '.run/AI Issue Fixer runner.run.xml',
    ]) assert.ok(!existsSync(join(root, f)), `${f} should be deleted`);
    assert.ok(!/dev:issue-fixer/.test(read('package.json')));
});

check('no code or workflow still reads DEV_HANDOFF_TOKEN or calls the old endpoint', () => {
    const dirs = ['netlify/functions', 'src/utils', 'scripts', '.github/workflows'];
    for (const d of dirs) for (const f of readdirSync(join(root, d))) {
        if (!/\.(ts|mjs|js|yml|sh)$/.test(f)) continue;
        const src = read(`${d}/${f}`);
        assert.ok(!src.includes('DEV_HANDOFF_TOKEN'), `${d}/${f} reads DEV_HANDOFF_TOKEN`);
        assert.ok(!/admin-issue-handoff\?/.test(src), `${d}/${f} calls admin-issue-handoff`);
    }
});

const api = read('netlify/functions/admin-issue-reports.ts');

check('nothing sets the runner’s queued states any more', () => {
    for (const v of ["devHandoffStatus: 'queued'", "devMergeStatus: 'queued'", "devMergeStatus: 'conflict_queued'", "devProdStatus: 'queued'"]) {
        assert.ok(!api.includes(v), v);
    }
});

check('leftovers can be started again: pass on, merge, redo, hotfix', () => {
    // The cloud AI developer (handoff / redo-fix) was removed 2026-11-13: Claude works tickets from a session.
    assert.ok(!api.includes("action === 'handoff'") && !api.includes("action === 'redo-fix'"));
    const merge = api.slice(api.indexOf("action === 'request-merge' && id"), api.indexOf("action === 'request-prod-promote'"));
    assert.ok(!merge.includes("issue.devMergeStatus === 'queued'"), 'a queued merge is not 409d');
    const prod = api.slice(api.indexOf("action === 'request-prod-promote'"), api.indexOf("action === 'request-merge-all'"));
    assert.ok(prod.includes("['hotfix_requested', 'hotfix_open'].includes(issue.devProdStatus)"), 'old promotions do not block');
    assert.ok(!api.includes('handoffCancelled'), 'the On Hold cancel of a laptop queue is gone');
});

check('the panel shows leftovers as what can be done now, with no runner wording', () => {
    const html = read('admin.html');
    assert.ok(html.includes('function _irNoLaptop(i)'));
    for (const fn of ['function _irHandoffBadge(i) {', 'function _irMergeCard(i) {', 'function _irRunnerChip(i) {']) {
        const at = html.indexOf(fn);
        assert.ok(at > -1 && html.slice(at, at + 200).includes('i = _irNoLaptop(i);'), fn);
    }
    assert.ok(!/developer runner|Re-queue|🖥/.test(html));
    assert.ok(html.includes("const canStart = !ps || ps === 'failed' || ps === 'queued' || ps === 'promoting';"));
});

check('the clean-up SQL only releases laptop-held rows, threads a hidden note, and is wrapped in a transaction', () => {
    const q = read('db/z-retire-laptop-runner.sql');
    assert.ok(q.includes('BEGIN;') && q.includes('COMMIT;'));
    assert.strictEqual((q.match(/IS DISTINCT FROM 'GitHub Actions'/g) ?? []).length, 2 + 2, 'both UPDATEs on held rows skip cloud rows (plus the check query)');
    assert.strictEqual((q.match(/SELECT id, 'admin', NULL,/g) ?? []).length, 4, 'author_id NULL: the reporter never sees it');
    assert.ok(!/DELETE|DROP|TRUNCATE/i.test(q.replace(/^--.*$/gm, '')));
});

console.log(`\n${passed} passed`);
