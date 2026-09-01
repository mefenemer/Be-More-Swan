// tests/seed-connection.test.ts
// Which database a seed script writes to — and the fallback that used to answer "production".
//
// ── The bug ─────────────────────────────────────────────────────────────────────────────────────
// Four seed scripts opened with `NETLIFY_DATABASE_URL || DATABASE_URL`. In this repo the first is
// STAGING and the bare second is PRODUCTION, so the fallback's only effect was: whenever `.env`
// failed to load — a different working directory, a shell without dotenv, CI — the script silently
// seeded prod. No error, nothing to notice, and `db:seed-catalog` upserts integration providers
// and scenarios, so the quiet outcome was overwriting live rows.
//
// The checks below are mostly about the ABSENCE of that fallback, in both the resolver and the
// four call sites, because "it works" and "it works against the right database" look identical
// from the outside until they very much do not.
//
// No database: pure resolution logic plus source scans.
// Run:  npx tsx tests/seed-connection.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTarget, readUrlVar, resolveSeedConnection } from '../db/seed-connection';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const SEEDS = [
    'db/seed-catalog.ts',
    'db/seed-plan-features.ts',
    'db/seed-assistant-content.ts',
    'db/seed-demo-tenant.ts',
];

/** Run fn with a controlled environment, always restoring it. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k];
        if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    try { fn(); } finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
    }
}

console.log('\n──── the fallback that seeded production is gone ────');

check('a missing NETLIFY_DATABASE_URL REFUSES, even with DATABASE_URL set', () => {
    // ⚠️ THE REGRESSION TEST. This is the exact state the bug needed: .env did not load, so the
    // staging variable is absent — and DATABASE_URL, which points at PRODUCTION, is sitting there
    // looking like a reasonable second choice.
    withEnv({
        NETLIFY_DATABASE_URL: undefined,
        DATABASE_URL: 'postgres://u:p@prod-host.example/neondb',
    }, () => {
        assert.throws(() => resolveSeedConnection('db:seed-catalog'), /NETLIFY_DATABASE_URL is not set/);
    });
});

check('the refusal does not suggest another variable to try', () => {
    // Suggesting a fallback in the error message is how the original bug grows back.
    withEnv({ NETLIFY_DATABASE_URL: undefined, DATABASE_URL: 'postgres://u:p@prod-host.example/db' }, () => {
        let message = '';
        try { resolveSeedConnection('db:seed-catalog'); } catch (e) { message = String(e); }
        assert.ok(!/\bDATABASE_URL\b(?!_)/.test(message.replace(/NETLIFY_DATABASE_URL/g, '')),
            'the error points the operator at the production variable');
        assert.match(message, /no fallback/i);
    });
});

check('no seed script still reads the bare variable in CODE', () => {
    // Scanned with comments stripped: all four now EXPLAIN the absent fallback by name, and a scan
    // that reads prose as code would report the explanation as the violation.
    for (const f of SEEDS) {
        const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        assert.ok(!/process\.env\.DATABASE_URL/.test(code), `${f} still falls back to DATABASE_URL`);
        assert.match(code, /seedConnection\(/, `${f} is not using the shared resolver`);
    }
});

console.log('\n──── reaching production is something you type ────');

check('the default variable is the staging one', () => {
    assert.equal(readUrlVar([]), 'NETLIFY_DATABASE_URL');
});

check('both --url-var spellings work, because both already exist in this repo', () => {
    // db-migrate.mjs uses the space form, rescore-lead-prospect-type.ts the equals form. An
    // operator who learned one should not be told the other is wrong.
    assert.equal(readUrlVar(['--url-var', 'DATABASE_URL_PROD']), 'DATABASE_URL_PROD');
    assert.equal(readUrlVar(['--url-var=DATABASE_URL_PROD']), 'DATABASE_URL_PROD');
});

check('a dangling --url-var falls back to the default rather than eating the next flag', () => {
    assert.equal(readUrlVar(['--url-var']), 'NETLIFY_DATABASE_URL');
    assert.equal(readUrlVar(['--url-var', '--dry-run']), 'NETLIFY_DATABASE_URL');
});

check('an explicitly named variable resolves', () => {
    withEnv({ MY_TARGET_DB: 'postgres://u:p@somewhere.example/neondb' }, () => {
        assert.equal(
            resolveSeedConnection('db:seed-catalog', ['--url-var', 'MY_TARGET_DB']),
            'postgres://u:p@somewhere.example/neondb',
        );
    });
});

console.log('\n──── the target is announced, the password never is ────');

check('describeTarget gives host and database only', () => {
    const d = describeTarget('postgres://user:hunter2@ep-x.eu-west-2.aws.neon.tech/neondb?sslmode=require', 'X');
    assert.match(d, /ep-x\.eu-west-2\.aws\.neon\.tech\/neondb/);
    assert.ok(!d.includes('hunter2'), 'the password reached the console');
    assert.ok(!d.includes('user'), 'the username reached the console');
});

check('an unparseable value is described, never echoed', () => {
    // ⚠️ The case where echoing would be worst: a malformed value is exactly the one most likely to
    // be a pasted credential, and it would land in a terminal or a CI log.
    const d = describeTarget('postgres//malformed:hunter2@host', 'X');
    assert.ok(!d.includes('hunter2'));
    assert.match(d, /unparseable/);
});

check('every seed script announces its target before writing anything', () => {
    // db:seed-catalog upserts integration providers and scenarios. An operator should never have
    // to guess which server that just happened on.
    const helper = read('db/seed-connection.ts');
    assert.match(helper, /export function seedConnection/);
    assert.match(helper, /console\.log\(`\$\{scriptName\} → \$\{describeTarget/);
});

console.log(`\n${passed} checks passed.\n`);
