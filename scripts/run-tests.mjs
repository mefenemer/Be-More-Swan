#!/usr/bin/env node
// Runs every tests/*.test.ts via tsx in its OWN process (isolation: the tests set
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
import { spawnSync } from 'node:child_process';
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

console.log(`Running ${files.length} test file(s) via tsx…\n`);
const failed = [];
for (const f of files) {
    console.log(`──────── ${f} ────────`);
    const res = spawnSync(tsxBin, [join('tests', f)], { cwd: root, stdio: 'inherit', env: process.env });
    // A spawn that never ran (status null / res.error) is an environment fault, not a test failure.
    // Bail immediately rather than marching through the rest reporting the same phantom.
    if (res.error || res.status === null) {
        console.error(`\n✗ Could not run ${f}: ${res.error?.message ?? 'process did not start'}`);
        console.error('This is an environment problem, not a failing test. Check the tsx install.');
        process.exit(1);
    }
    if (res.status !== 0) failed.push(f);
    console.log('');
}

if (failed.length) {
    console.error(`\n✗ ${failed.length}/${files.length} test file(s) failed:`);
    failed.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
}
console.log(`✓ All ${files.length} test file(s) passed.`);
