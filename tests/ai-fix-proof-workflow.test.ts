// tests/ai-fix-proof-workflow.test.ts
// ai-fix.yml's proof (docs/fix-pipeline-proof-plan.md): the fix job splits Claude's reply into summary,
// SQL and root cause; the "prove" job runs the repro test with NO secrets; publish reads the results,
// refuses a fix that fails its own repro test, and writes a proof block the app can parse.
// Runs the workflow's own node scripts against sample output, and checks the job boundaries.
import assert from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseProof, rootCauseStatus } from '../src/utils/issue-fix-proof';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = readFileSync(join(root, '.github/workflows/ai-fix.yml'), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

/** The n-th `node <<'NODE'` script in the workflow, de-indented. */
function nodeScript(n: number): string {
    const blocks = [...wf.matchAll(/node <<'NODE'\n([\s\S]*?)\n\s*NODE\n/g)].map((m) => m[1]);
    const b = blocks[n];
    assert.ok(b, `node script ${n} not found`);
    const indent = Math.min(...b.split('\n').filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
    return b.split('\n').map((l) => l.slice(indent)).join('\n');
}
function runNode(script: string, env: Record<string, string>) {
    return spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ...env }, encoding: 'utf8' });
}
function job(name: string): string {
    const start = wf.indexOf(`\n  ${name}:\n`);
    assert.notStrictEqual(start, -1, `job ${name} missing`);
    const rest = wf.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][a-z-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

check('split step: summary, SQL and root cause come apart', () => {
    const out = mkdtempSync(join(tmpdir(), 'aifix-'));
    const reply = 'Fixed it.\n---ROOT-CAUSE-START---\nStatus: identified\nfoo.ts:12 drops the error\n---ROOT-CAUSE-END---\n---SQL-MIGRATION-START---\nALTER TABLE t ADD COLUMN IF NOT EXISTS a text;\n---SQL-MIGRATION-END---\nSummary: done.';
    writeFileSync(join(out, 'claude.json'), JSON.stringify({ result: reply }));
    const r = runNode(nodeScript(0), { OUT: out });
    assert.strictEqual(r.status, 0, r.stderr);
    const rc = JSON.parse(readFileSync(join(out, 'rootcause.json'), 'utf8'));
    assert.deepStrictEqual(rc, { claimed: 'identified', rootCause: 'foo.ts:12 drops the error' });
    assert.match(readFileSync(join(out, 'sql.txt'), 'utf8'), /^ALTER TABLE t/);
    const summary = readFileSync(join(out, 'summary.txt'), 'utf8');
    assert.ok(!/ROOT-CAUSE|SQL-MIGRATION|foo\.ts:12/.test(summary), summary);
});

function publishWith(repro: unknown, rc = { claimed: 'identified', rootCause: 'foo.ts:12 <!-- --> drops it' }) {
    const tmp = mkdtempSync(join(tmpdir(), 'aifix-pub-'));
    const out = join(tmp, 'out'); mkdirSync(out); mkdirSync(join(tmp, 'proof'));
    writeFileSync(join(out, 'rootcause.json'), JSON.stringify(rc));
    if (repro) writeFileSync(join(tmp, 'proof', 'repro.json'), JSON.stringify(repro));
    const r = runNode(nodeScript(1), { OUT: out, RUNNER_TEMP: tmp, GITHUB_RUN_ID: '987' });
    return { r, out };
}

check('publish: fail-then-pass → a proof block the app reads as CONFIRMED', () => {
    const { r, out } = publishWith({ test: 'tests/repro-issue-42.test.ts', kind: 'node', before: { exit: 1, tail: 'AssertionError' }, after: { exit: 0, tail: 'ok' }, flags: [], screenshots: 0 });
    assert.strictEqual(r.status, 0, r.stderr);
    const block = readFileSync(join(out, 'proof.json'), 'utf8');
    assert.ok(!/[<>]/.test(block), 'no raw < or > inside the HTML comment');
    const proof = parseProof(`<!-- ai-fix:proof:start -->\n${block}\n<!-- ai-fix:proof:end -->`);
    assert.strictEqual(proof?.runId, 987);
    assert.strictEqual(proof?.rootCause, 'foo.ts:12 <!-- --> drops it');
    assert.strictEqual(rootCauseStatus(proof), 'confirmed');
    assert.match(readFileSync(join(out, 'proof.md'), 'utf8'), /CONFIRMED/);
});

check('publish: a fix that fails its own repro test opens no PR', () => {
    const { r, out } = publishWith({ test: 'tests/repro-issue-42.test.ts', kind: 'node', before: { exit: 1 }, after: { exit: 1, tail: 'still broken' }, flags: [] });
    assert.notStrictEqual(r.status, 0);
    assert.match(readFileSync(join(out, 'reason.txt'), 'utf8'), /does not make its own repro test pass/);
});

check('publish: no proof (prove job died) → still a PR, root cause not confirmed', () => {
    const { r, out } = publishWith(null);
    assert.strictEqual(r.status, 0, r.stderr);
    const proof = parseProof(`<!-- ai-fix:proof:start -->${readFileSync(join(out, 'proof.json'), 'utf8')}<!-- ai-fix:proof:end -->`);
    assert.strictEqual(rootCauseStatus(proof), 'guessed');
    assert.match(String(proof?.repro.error), /did not finish/);
});

check('prove job: no secrets, read-only token, credentials not kept', () => {
    const j = job('prove');
    assert.ok(!/secrets\./.test(j), 'prove must not reference any secret');
    assert.match(j, /permissions:\n\s+contents: read/);
    assert.match(j, /persist-credentials: false/);
    assert.ok(!/GH_TOKEN|github\.token/.test(j));
});

check('prove job: before = only the repro test added; after = the whole fix; screenshots kept', () => {
    const j = job('prove');
    assert.ok(j.indexOf('git apply --include="$test"') < j.indexOf('before=$(run before)'));
    assert.ok(j.indexOf('before=$(run before)') < j.indexOf('git apply "$C/fix.patch"'));
    assert.match(j, /source_scan/);
    assert.match(j, /missing_code/);
    assert.match(j, /E2E_SCREENSHOT=on/);
    assert.match(j, /name: ai-fix-proof/);
});

check('only publish pushes, and only the issue branch', () => {
    assert.ok(!/git[^\n]*push/.test(job('fix')), 'fix job must not push');
    assert.ok(!/git[^\n]*push/.test(job('prove')), 'prove job must not push');
    assert.match(job('publish'), /HEAD:refs\/heads\/\$branch/);
    assert.match(job('publish'), /if: always\(\) && needs\.fix\.result == 'success'/);
});

check('the prompt asks for the repro test and the root-cause block', () => {
    assert.match(wf, /tests\/repro-issue-<ID>\.test\.ts/);
    assert.match(wf, /e2e\/repro-issue-<ID>\.spec\.ts/);
    assert.match(wf, /---ROOT-CAUSE-START---/);
    assert.match(wf, /ON CONFLICT\s*\n?\s*\(title\) DO NOTHING/);
});

check('Playwright keeps every screenshot only when asked (E2E_SCREENSHOT=on)', () => {
    const cfg = readFileSync(join(root, 'playwright.config.ts'), 'utf8');
    assert.match(cfg, /process\.env\.E2E_SCREENSHOT === 'on' \? 'on' : 'only-on-failure'/);
    assert.ok(existsSync(join(root, 'netlify/functions/build-info.ts')));
});

console.log(`\nai-fix-proof-workflow: ${passed} passed`);
