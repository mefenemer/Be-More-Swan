// tests/env-routing.test.ts
// Epic: Superadmin Environment Management — US3.3 (Strict Production Default).
//
// Run:  npx tsx tests/env-routing.test.ts
//
// Verifies the security-critical resolution rules in src/utils/env-context.ts:
//   - missing / malformed X-Environment header → 'live'
//   - 'sandbox' only resolves to sandbox when allowed AND provisioned
//   - a non-super-admin (allowSandbox:false) is always forced to 'live'
//   - the AsyncLocalStorage context defaults to 'live' and nests correctly
// Pure logic — no DB required.

import assert from 'node:assert';
import {
    resolveEnvironment,
    runWithEnvironment,
    currentEnv,
    isSandbox,
} from '../src/utils/env-context';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): void {
    try {
        const r = fn();
        if (r instanceof Promise) { r.then(() => { passed++; console.log(`  ✓ ${name}`); }).catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }); }
        else { passed++; console.log(`  ✓ ${name}`); }
    } catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SANDBOX_PROVISIONED = { allowSandbox: true };

// Ensure sandbox is "provisioned" for the resolution tests.
process.env.SANDBOX_DATABASE_URL = 'postgres://sandbox-test/db';

check('missing header → live (AC 3.3)', () => {
    assert.equal(resolveEnvironment({}, SANDBOX_PROVISIONED), 'live');
    assert.equal(resolveEnvironment(undefined, SANDBOX_PROVISIONED), 'live');
});

check('malformed / unknown header values → live', () => {
    assert.equal(resolveEnvironment({ 'x-environment': 'test' }, SANDBOX_PROVISIONED), 'live');
    assert.equal(resolveEnvironment({ 'x-environment': '' }, SANDBOX_PROVISIONED), 'live');
    assert.equal(resolveEnvironment({ 'x-environment': 'prod' }, SANDBOX_PROVISIONED), 'live');
    assert.equal(resolveEnvironment({ 'x-environment': 'sandbox!' }, SANDBOX_PROVISIONED), 'live');
});

check('exact "sandbox" (case-insensitive, trimmed) → sandbox when allowed', () => {
    assert.equal(resolveEnvironment({ 'x-environment': 'sandbox' }, SANDBOX_PROVISIONED), 'sandbox');
    assert.equal(resolveEnvironment({ 'x-environment': 'SANDBOX' }, SANDBOX_PROVISIONED), 'sandbox');
    assert.equal(resolveEnvironment({ 'x-environment': '  Sandbox  ' }, SANDBOX_PROVISIONED), 'sandbox');
});

check('non-super-admin (allowSandbox:false) forced to live even with sandbox header', () => {
    assert.equal(resolveEnvironment({ 'x-environment': 'sandbox' }, { allowSandbox: false }), 'live');
});

check('sandbox header falls back to live when SANDBOX_DATABASE_URL unset', () => {
    const saved = process.env.SANDBOX_DATABASE_URL;
    delete process.env.SANDBOX_DATABASE_URL;
    assert.equal(resolveEnvironment({ 'x-environment': 'sandbox' }, SANDBOX_PROVISIONED), 'live');
    process.env.SANDBOX_DATABASE_URL = saved;
});

check('currentEnv() defaults to live outside any context', () => {
    assert.equal(currentEnv(), 'live');
    assert.equal(isSandbox(), false);
});

check('runWithEnvironment binds and nests the context', async () => {
    await runWithEnvironment('sandbox', async () => {
        assert.equal(currentEnv(), 'sandbox');
        assert.equal(isSandbox(), true);
        await runWithEnvironment('live', async () => {
            assert.equal(currentEnv(), 'live');
        });
        assert.equal(currentEnv(), 'sandbox', 'context restored after nested run');
    });
    assert.equal(currentEnv(), 'live', 'context cleared after run');
});

process.on('exit', () => {
    console.log(`\n${passed} checks passed.`);
});
