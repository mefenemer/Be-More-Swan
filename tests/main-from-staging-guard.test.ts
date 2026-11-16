// tests/main-from-staging-guard.test.ts
// The "Main only from staging" check (.github/workflows/main-from-staging.yml) must let exactly three
// kinds of PR into main: the staging promote, hotfix-pr.yml's hotfix/issue-<n> branches, and a
// deliberate `direct-to-main` exception. The script runs here against each case, so a later edit
// that loosens or breaks it fails CI.
//
// Run:  npx tsx tests/main-from-staging-guard.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = readFileSync(join(root, '.github/workflows/main-from-staging.yml'), 'utf8');
const hotfix = readFileSync(join(root, '.github/workflows/hotfix-pr.yml'), 'utf8');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// The `run: |` block, de-indented.
const runIdx = wf.indexOf('run: |');
const lines = wf.slice(runIdx).split('\n').slice(1);
const indent = lines[0].match(/^\s*/)![0].length;
const script = lines.filter(l => l.trim() === '' || l.match(/^\s*/)![0].length >= indent).map(l => l.slice(indent)).join('\n');

function run(headRef: string, labels: string[] = [], headRepo = 'mefenemer/Be-More-Swan'): number {
    const r = spawnSync('bash', ['-c', script], {
        env: { ...process.env, HEAD_REF: headRef, HEAD_REPO: headRepo, THIS_REPO: 'mefenemer/Be-More-Swan', LABELS: JSON.stringify(labels) },
        encoding: 'utf8',
    });
    return r.status ?? -1;
}

console.log('\n──── Main only from staging ────');
check('runs on PRs into main, under the name the ruleset will require', () => {
    assert.match(wf, /pull_request:\s*\n\s*branches: \[main\]/);
    assert.match(wf, /name: Main only from staging\s*\n\s*runs-on/);
    assert.match(wf, /types: \[[^\]]*labeled[^\]]*unlabeled[^\]]*\]/, 'adding the label must re-run the check');
});
check('event values reach the script only through env', () => {
    assert.ok(!/\$\{\{/.test(script), 'no ${{ }} inside the run block');
});
check('staging passes', () => assert.strictEqual(run('staging'), 0));
check('hotfix/issue-<n> passes', () => assert.strictEqual(run('hotfix/issue-42'), 0));
check('the hotfix branch name still matches what hotfix-pr.yml creates', () => {
    assert.match(hotfix, /branch="hotfix\/issue-\$ISSUE_ID"/);
});
check('a feature branch fails', () => assert.strictEqual(run('feat/shop-phase0'), 1));
check('a look-alike hotfix branch fails', () => {
    assert.strictEqual(run('hotfix/issue-42-and-more'), 1);
    assert.strictEqual(run('hotfix/shop'), 1);
});
check('`staging` from a fork fails', () => assert.strictEqual(run('staging', [], 'someone/fork'), 1));
check('the direct-to-main label lets a feature branch through', () => {
    assert.strictEqual(run('feat/x', ['direct-to-main']), 0);
    assert.strictEqual(run('feat/x', ['direct-to-main-ish']), 1);
});
check('a branch name with shell in it is just a name', () => assert.strictEqual(run('x$(exit 0);echo'), 1));

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
