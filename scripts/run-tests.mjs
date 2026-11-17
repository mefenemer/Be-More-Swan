#!/usr/bin/env node
// Runs every tests/*.test.ts via tsx, each in its OWN process (isolation: the tests set
// process.exitCode and mutate process.env, so they must not share a runtime), and fails
// if any file fails. Auto-discovers test files so new ones are included automatically.
//
// EXCLUDED by default: rls-enforcement.test.ts — it connects to a REAL database and asserts
// Row-Level Security actually isolates tenants. That only passes against a DB with the RLS
// policies applied (db/rls/*.sql). Running it against a plain dev/staging DB (no RLS) would
// fail spuriously AND write throwaway rows there. It runs in its own CI job against a
// freshly-provisioned Postgres (see .github/workflows/ci.yml → rls). Run it locally with
// `npm run test:rls` when APP_DATABASE_URL points at a proper RLS-provisioned branch.

import { readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'tests');
const EXCLUDE = new Set(['rls-enforcement.test.ts']);
// Resolve tsx by walking up from the repo root. A git worktree has no node_modules of its own —
// dependencies live in the main checkout — so a hardcoded `<root>/node_modules/.bin/tsx` silently
// misses there. That mattered: spawnSync on a missing binary returns a non-zero status with NO
// output, so every test file was reported as FAILED with nothing to explain why. A broken
// environment must not be indistinguishable from broken code.
function resolveTsx() {
    for (let dir = root; ; dir = dirname(dir)) {
        const candidate = join(dir, 'node_modules', '.bin', 'tsx');
        if (existsSync(candidate)) return candidate;
        if (dirname(dir) === dir) return null;
    }
}

const tsxBin = resolveTsx();
if (!tsxBin) {
    console.error('Could not find the `tsx` binary in node_modules/.bin (searched this directory and its parents).');
    console.error('Run `npm install` — in a git worktree, install in the main checkout.');
    process.exit(1);
}

const files = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.ts') && !EXCLUDE.has(f))
    .sort();

if (!files.length) {
    console.error('No test files found in tests/');
    process.exit(1);
}

// Files run in parallel, each still in its OWN tsx process (isolation unchanged). Output is captured
// per file and printed as one block when that file finishes, so logs never interleave.
// TEST_CONCURRENCY=1 restores the old one-at-a-time run (useful when chasing an ordering suspicion).
// TEST_SHARD=i/n runs every n-th file starting at i (1-based) — for splitting across CI runners.
const concurrency = Math.max(1, Number(process.env.TEST_CONCURRENCY) || availableParallelism());
let selected = files;
const shard = process.env.TEST_SHARD?.match(/^(\d+)\/(\d+)$/);
if (process.env.TEST_SHARD && !shard) {
    console.error(`TEST_SHARD must look like 1/3, got "${process.env.TEST_SHARD}"`);
    process.exit(1);
}
if (shard) {
    const [i, n] = [Number(shard[1]), Number(shard[2])];
    // An out-of-range shard would select nothing and "pass" — fail loudly instead.
    if (i < 1 || i > n) {
        console.error(`TEST_SHARD ${i}/${n} is out of range: the first number must be 1–${n}.`);
        process.exit(1);
    }
    selected = files.filter((_, k) => k % n === i - 1);
}

console.log(`Running ${selected.length} test file(s) via tsx, ${concurrency} at a time…\n`);
const started = Date.now();
const failed = [];
const timings = [];
let envFault = null;

function runOne(f) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const chunks = [];
        let child;
        try {
            child = spawn(tsxBin, [join('tests', f)], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ f, fault: err.message });
            return;
        }
        child.stdout.on('data', (c) => chunks.push(c));
        child.stderr.on('data', (c) => chunks.push(c));
        // A spawn that never ran is an environment fault, not a test failure.
        child.on('error', (err) => resolve({ f, fault: err.message }));
        child.on('close', (code, signal) => {
            resolve({ f, code, signal, ms: Date.now() - t0, out: Buffer.concat(chunks).toString() });
        });
    });
}

const queue = [...selected];
async function worker() {
    while (queue.length && !envFault) {
        const f = queue.shift();
        const r = await runOne(f);
        if (r.fault) {
            envFault = r;
            return;
        }
        timings.push([r.ms, f]);
        const ok = r.code === 0;
        if (!ok) failed.push(f);
        process.stdout.write(`──────── ${f} (${(r.ms / 1000).toFixed(1)}s)${ok ? '' : ' ✗ FAILED'} ────────\n${r.out}\n`);
    }
}
await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));

if (envFault) {
    console.error(`\n✗ Could not run ${envFault.f}: ${envFault.fault}`);
    console.error('This is an environment problem, not a failing test. Check the tsx install.');
    process.exit(1);
}

timings.sort((a, b) => b[0] - a[0]);
console.log(`Slowest files:`);
timings.slice(0, 8).forEach(([ms, f]) => console.log(`   ${(ms / 1000).toFixed(1)}s  ${f}`));
console.log(`Wall time ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

if (failed.length) {
    failed.sort();
    console.error(`\n✗ ${failed.length}/${selected.length} test file(s) failed:`);
    failed.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
}
console.log(`✓ All ${selected.length} test file(s) passed.`);
