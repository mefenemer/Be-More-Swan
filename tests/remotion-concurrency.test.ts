// tests/remotion-concurrency.test.ts
// How a render is sized against the AWS Lambda concurrency quota (src/lib/remotion-lambda.ts).
//
// Worth testing without a Lambda because the failure this guards is invisible until it is billed and
// public: Remotion's DEFAULT fan-out asks for ~15 renderer Lambdas for a 10s clip, our AWS account
// allows 10 concurrent executions in total, and the render dies at the launch invoke with
// "AWS Concurrency limit reached (Rate Exceeded)". The post then keeps the still it was supposed to
// become, and a video-only platform refuses it with "A Short can't carry this" — two error messages,
// neither of which names the actual cause.
//
// Run:  npx tsx tests/remotion-concurrency.test.ts

import assert from 'node:assert';
import { isConcurrencyError, planConcurrency } from '../src/lib/remotion-lambda';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// The default budget, with REMOTION_MAX_LAMBDAS unset. The launch function is one MORE Lambda on top
// of whatever this returns, and two renders may overlap, so the whole point is that
//   2 * (1 launch + BUDGET renderers) <= the account's concurrency limit of 10.
const BUDGET = 3;

check('the weekly Short fits the quota — the case that was failing in production', () => {
    // 10s at 30fps. Remotion's own default would chunk this at 20 frames => 15 renderer Lambdas,
    // plus the launch function, against an account limit of 10.
    assert.equal(planConcurrency(300), BUDGET);
    assert.ok(2 * (1 + planConcurrency(300)) <= 10,
        'two overlapping Short renders must still fit inside a concurrency limit of 10');
});

check('no render ever exceeds the budget, however long the clip', () => {
    // MAX_RENDER_SECONDS is 600, i.e. 18000 frames — the longest thing that can be queued at all.
    for (const frames of [300, 900, 1800, 18000]) {
        assert.ok(planConcurrency(frames) <= BUDGET, `${frames} frames asked for more than ${BUDGET}`);
    }
});

check('a very short clip does not spend budget it cannot use', () => {
    // Under ~a second per Lambda the cold start dominates, so splitting buys nothing and starves
    // whatever renders next.
    assert.equal(planConcurrency(30), 1);
    assert.equal(planConcurrency(45), 2);   // ceil(45/30)
    assert.equal(planConcurrency(90), 3);
});

check('junk never becomes a zero, a fraction, or a NaN Lambda count', () => {
    // durationInFrames is computed from a duration read off a <video> element, so none of this is
    // hypothetical. Remotion rejects a non-integer or non-positive concurrency with a TypeError
    // thrown deep inside the launch call.
    for (const junk of [0, -5, NaN, Infinity, 1.5, undefined, null, 'many']) {
        const n = planConcurrency(junk as unknown as number);
        assert.ok(Number.isInteger(n) && n >= 1 && n <= BUDGET, `planConcurrency(${String(junk)}) = ${n}`);
    }
});

check('the rate-limit error is recognised in every shape AWS reports it', () => {
    // Remotion's prose wrapper, as seen in the Review Queue.
    assert.ok(isConcurrencyError(new Error(
        'AWS Concurrency limit reached (Original Error: Rate Exceeded.). See https://www.remotion.dev/docs/lambda/troubleshooting/rate-limit for tips to fix this.')));
    // The raw SDK exception, which Remotion matches on the STACK rather than the message.
    const onStack = new Error('some opaque failure');
    onStack.stack = 'Error: some opaque failure\n    at TooManyRequestsException (/var/task/index.js:1:1)';
    assert.ok(isConcurrencyError(onStack));
    assert.ok(isConcurrencyError(new Error('ConcurrentInvocationLimitExceeded')));
    // getRenderProgress hands back a bare string, not an Error.
    assert.ok(isConcurrencyError('Rate Exceeded.'));
});

check('an ordinary render failure is NOT retried as a rate limit', () => {
    // Retrying these wastes the worker's 10-minute poll budget and fails identically at the end.
    assert.ok(!isConcurrencyError(new Error('Cannot find composition PostOverlay')));
    assert.ok(!isConcurrencyError(new Error('The render finished but produced no file.')));
    assert.ok(!isConcurrencyError(null));
    assert.ok(!isConcurrencyError(undefined));
});

console.log(`\n${passed}/6 passed`);
