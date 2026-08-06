// tests/publish-failure-diagnostics.test.ts
// The three things that made a live Threads outage undiagnosable, pinned so they cannot regress.
// Run:  npx tsx tests/publish-failure-diagnostics.test.ts
//
// WHY IT IS WORTH TESTING. On 2026-08-06 prod Threads posts had been failing with
// `{"httpStatus":400,"errorMessage":"The requested resource does not exist"}` — a sentence that
// names no cause, on a connection whose row read `active` with
// `scopes: threads_basic,threads_content_publish`. Three separate defects stacked up, and each one
// individually would have been survivable:
//
//   1. DriverResult carried no errorCode, so Meta's number — the ONLY thing separating "you lost a
//      permission" from "that object isn't there" — was discarded at the driver boundary and the
//      Review Queue could only say `unknown`.
//   2. The publisher logged nothing on a driver-returned failure (only on a THROWN one), so seven
//      days of function logs looked perfectly healthy while posts died.
//   3. `scopes` held a hardcoded SCOPES.* constant, so the row appeared to prove the token could
//      publish. It proved only what we had asked for.
//
// Together they turned a one-query diagnosis into a long one. These checks are cheap; the failure
// mode they guard is silent, which is exactly the kind worth a test.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { metaError, type DriverResult } from '../src/utils/social-publish';
import { diagnosePostFailure } from '../src/utils/post-failure-diagnosis';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nGraph error extraction\n');

check('pulls message, code and subcode out of a Graph error body', () => {
    const r = metaError({ error: { message: 'Bad thing', code: 190, error_subcode: 460 } }, 'fallback');
    assert.equal(r.error, 'Bad thing');
    assert.equal(r.errorCode, 190);
    assert.equal(r.errorSubcode, 460);
});

check('falls back to the caller sentence when the body is empty or unparseable', () => {
    // A gateway error page or a truncated response — the caller must still get a sentence.
    for (const body of [{}, null, undefined, { error: {} }, { error: { message: '   ' } }]) {
        const r = metaError(body, 'Threads container error (400)');
        assert.equal(r.error, 'Threads container error (400)', `body: ${JSON.stringify(body)}`);
    }
});

check('an absent code stays null — never coerced to 0', () => {
    // 0 is a real Graph code. Inventing one would make AUTH_CODES/THROTTLE_CODES lookups lie.
    const r = metaError({ error: { message: 'No code here' } }, 'fallback');
    assert.strictEqual(r.errorCode, null);
    assert.strictEqual(r.errorSubcode, null);
    const s = metaError({ error: { message: 'x', code: '190' } }, 'fallback');
    assert.strictEqual(s.errorCode, null, 'a string code is not a number and must not be trusted');
});

console.log('\nThe code survives to the diagnosis\n');

check('a 400 with no code is still honestly unknown', () => {
    // Exactly the prod Threads blob. Without a code there is nothing to classify on, and the
    // diagnosis must NOT invent a cause — it should hand back the platform's own words.
    const d = diagnosePostFailure(
        { httpStatus: 400, errorMessage: 'The requested resource does not exist', isRetryable: false },
        'Threads',
    );
    assert.equal(d.kind, 'unknown');
    assert.equal(d.raw, 'The requested resource does not exist');
});

check('the SAME failure carrying Meta code 190 is classified as a connection problem', () => {
    // This is the whole point of threading errorCode through: identical message and status, but now
    // the reviewer is told to reconnect instead of being shown a dead end.
    const d = diagnosePostFailure(
        { httpStatus: 400, errorCode: 190, errorMessage: 'The requested resource does not exist', isRetryable: false },
        'Threads',
    );
    assert.equal(d.kind, 'connection');
    assert.equal(d.needsReconnect, true);
    assert.equal(d.retryable, false, 'retrying a dead connection fails identically, every time');
});

check('a driver failure is assignable with the codes, and still without them', () => {
    // The fields are optional on purpose: X and LinkedIn report no comparable number, and an
    // absent code must stay absent rather than force every driver to fabricate one.
    const withCodes: DriverResult = { ok: false, status: 400, error: 'x', errorCode: 190, errorSubcode: 460 };
    const without: DriverResult = { ok: false, status: 500, error: 'y' };
    assert.equal(withCodes.ok, false);
    assert.equal(without.ok, false);
});

console.log('\nThe scopes column must not be fabricated\n');

// grantedScopes is module-private in oauth-integrations.ts (importing that module would pull in the
// whole OAuth router and its env). Re-stated here so the CONTRACT is pinned; the source-scan check
// below is what proves the real call sites obey it.
function grantedScopes(reported: unknown): string | null {
    if (Array.isArray(reported)) {
        const list = reported.map(s => String(s ?? '').trim()).filter(Boolean);
        return list.length ? list.join(',') : null;
    }
    if (typeof reported === 'string' && reported.trim()) return reported.trim();
    return null;
}

check('nothing reported means null — not a guess', () => {
    assert.strictEqual(grantedScopes(null), null);
    assert.strictEqual(grantedScopes(undefined), null);
    assert.strictEqual(grantedScopes(''), null);
    assert.strictEqual(grantedScopes('   '), null);
    assert.strictEqual(grantedScopes([]), null);
});

check('what the provider does report is kept verbatim, in both shapes', () => {
    assert.equal(grantedScopes('threads_basic'), 'threads_basic');
    assert.equal(grantedScopes(['threads_basic', 'threads_content_publish']), 'threads_basic,threads_content_publish');
    assert.equal(grantedScopes('  a b  '), 'a b');
});

check('no OAuth callback writes a SCOPES.* constant into the scopes column', () => {
    // The source scan is the real guard. A future provider added with `scopes: SCOPES.foo` would
    // reintroduce the exact bug this file exists for, and no unit test of a helper would catch it.
    const offenders = read('../netlify/functions/oauth-integrations.ts')
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => /^scopes:\s*SCOPES\./.test(line));
    assert.deepEqual(
        offenders,
        [],
        `these call sites write the REQUESTED scopes as if they were granted:\n${offenders.map(o => `  line ${o.n}: ${o.line}`).join('\n')}`,
    );
});

console.log(`\n${passed} checks passed\n`);
