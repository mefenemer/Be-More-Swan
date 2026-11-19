// tests/remotion-concurrency.test.ts
// How a render is sized against the AWS Lambda concurrency quota (src/lib/remotion-lambda.ts).
//
// Worth testing without a Lambda because the failure this guards is invisible until it is billed and
// public: Remotion's DEFAULT fan-out asks for ~15 renderer Lambdas for a 10s clip, our AWS account
// allowed 10 concurrent executions in total (1000 since 2026-11), and the render dies at the launch invoke with
// "AWS Concurrency limit reached (Rate Exceeded)". The post then keeps the still it was supposed to
// become, and a video-only platform refuses it with "A Short can't carry this" — two error messages,
// neither of which names the actual cause.
//
// Run:  npx tsx tests/remotion-concurrency.test.ts

import assert from 'node:assert';
import { isConcurrencyError, planConcurrency, FRAMES_PER_LAMBDA } from '../src/lib/remotion-lambda';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// The defaults, with REMOTION_MAX_LAMBDAS unset. The account quota was 10 when this guard was written
// (2026-08-02) and is 1000 since (checked 2026-11-18). Measured then: ~0.73 s a frame per renderer with a
// screen cover, so a renderer gets about 200 frames (≈150 s of its 300 s chunk timeout), never fewer than 3.
const SHORT = 3;
const CAP = 120;

check('the weekly Short still uses 3, as it always has', () => {
    // 10s at 30fps. Remotion's own default would chunk this at 20 frames => 15 renderer Lambdas.
    assert.equal(planConcurrency(300), SHORT);
    assert.equal(planConcurrency(600), SHORT);   // 20 s
});

check('every render is sized so no renderer gets more than 200 frames, within the cap', () => {
    // 60 s at 3 Lambdas was 600 frames each: ≈430 s with a cover, past the 300 s chunk timeout.
    for (const [frames, want] of [[900, 5], [1800, 9], [3600, 18], [9000, 45], [18000, 90]] as const) {
        assert.equal(planConcurrency(frames), want, `${frames} frames`);
        assert.ok(frames / planConcurrency(frames) <= FRAMES_PER_LAMBDA);
    }
    assert.equal(planConcurrency(18000 * 10), CAP, 'never past the cap');
    // Two 10-minute renders at once, launch functions included, stay far inside the 1000 quota.
    assert.ok(2 * (1 + planConcurrency(18000)) <= 200);
});

check('a very short clip does not spend budget it cannot use', () => {
    // Under ~a second per Lambda the cold start dominates, so splitting buys nothing.
    assert.equal(planConcurrency(30), 1);
    assert.equal(planConcurrency(45), 2);   // ceil(45/30)
    assert.equal(planConcurrency(90), 3);
});

check('junk never becomes a zero, a fraction, a NaN or a big Lambda count', () => {
    // durationInFrames is computed from a duration read off a <video> element, so none of this is
    // hypothetical. Remotion rejects a non-integer or non-positive concurrency deep inside the launch.
    for (const junk of [0, -5, NaN, Infinity, 1.5, undefined, null, 'many']) {
        const n = planConcurrency(junk as unknown as number);
        assert.ok(Number.isInteger(n) && n >= 1 && n <= SHORT, `planConcurrency(${String(junk)}) = ${n}`);
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
