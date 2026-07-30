// tests/graph-error-classification.test.ts
// goal-metric-selftest.ts decides which goal metrics are honestly offerable. This is the function
// that turns a Graph API failure into that verdict.
// Run:  npx tsx tests/graph-error-classification.test.ts
//
// WHY IT IS WORTH TESTING. The selftest exists to catch the linkedin_followers bug — a metric
// offered on the assumption that a written poller works. A misclassification here reintroduces that
// exact bug INSIDE the tool meant to prevent it, and it does so silently, because a wrong verdict
// still looks like a clean run. Both directions are dangerous and neither is obvious:
//
//   too lenient — a permission wall reported as `no_data` reads as "empty account", so an offered
//                 metric that can NEVER return a value is never flagged. Observed live on prod:
//                 instagram_profile_views returned "(#10) Application does not have permission" and
//                 was reported as no_data.
//   too strict  — a rate limit reported as a refusal puts a perfectly good metric into
//                 `shouldDisable`, and someone switches off a working metric after one unlucky run.

import assert from 'node:assert';
import { classifyGraphError } from '../netlify/functions/goal-metric-selftest';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('no error is not a verdict at all', () => {
    assert.equal(classifyGraphError(undefined), null);
    assert.equal(classifyGraphError(null), null);
});

check('#10 permission wall is a refusal, never no_data', () => {
    // The live prod finding this fix came from.
    const r = classifyGraphError({ code: 10, message: 'Application does not have permission for this action' })!;
    assert.equal(r.outcome, 'unauthorised');
    // The detail has to separate it from a token problem, because the remedy is completely
    // different — reconnecting the account does nothing; the APP needs the permission.
    assert.match(r.detail, /APP lacks this permission/);
    assert.match(r.detail, /Reconnecting the account will not help/);
});

check('#100 is the bad-metric-name case, and says which name', () => {
    const r = classifyGraphError({ code: 100, message: 'Invalid parameter' }, 'profile_views')!;
    assert.equal(r.outcome, 'unsupported');
    assert.match(r.detail, /"profile_views"/);
});

check('an expired token is a refusal, but a reconnectable one', () => {
    const r = classifyGraphError({ code: 190, message: 'Error validating access token' })!;
    assert.equal(r.outcome, 'unauthorised');
    assert.match(r.detail, /needs reconnecting/);
    // Must NOT claim the app is missing a permission — that would send someone to app review for a
    // problem the user fixes in ten seconds.
    assert.doesNotMatch(r.detail, /APP lacks/);
});

check('rate limits are inconclusive, NOT a reason to disable a metric', () => {
    // The mirror-image bug. `error` is excluded from both summary lists by design.
    for (const code of [4, 17, 32, 613]) {
        const r = classifyGraphError({ code, message: 'Application request limit reached' })!;
        assert.equal(r.outcome, 'error', `Graph #${code} must not read as a verdict`);
        assert.match(r.detail, /Re-run before drawing any conclusion/);
    }
});

check('transient Graph failures are inconclusive too', () => {
    for (const code of [1, 2]) {
        assert.equal(classifyGraphError({ code, message: 'Please retry' })!.outcome, 'error');
    }
});

check('an unrecognised code fails cautious, not confident', () => {
    // Being wrong the careful way costs one re-run. Being wrong the confident way disables a metric
    // that works, so an unknown code must never reach `unsupported` or `unauthorised`.
    const r = classifyGraphError({ code: 999999, message: 'Something new' })!;
    assert.equal(r.outcome, 'error');
    assert.match(r.detail, /unrecognised/i);
});

check('an error with no code at all is still surfaced', () => {
    const r = classifyGraphError({ message: 'Weird' })!;
    assert.equal(r.outcome, 'error');
    assert.match(r.detail, /Weird/);
});

check('no verdict-bearing outcome is ever returned for a retryable condition', () => {
    // Belt-and-braces over the whole retryable set: nothing here may land in shouldDisable.
    const verdicts = new Set(['unsupported', 'unauthorised']);
    for (const code of [1, 2, 4, 17, 32, 341, 613]) {
        assert.ok(!verdicts.has(classifyGraphError({ code })!.outcome), `#${code} leaked into a verdict`);
    }
});

console.log(`\n${passed} checks passed.`);
