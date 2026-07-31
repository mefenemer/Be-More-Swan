// tests/instagram-retry-classification.test.ts
//
// Which Instagram publishing failures are worth another attempt.
//
// Found by sweeping the publishers for the defect fixed in tests/x-media-failure.test.ts and
// tests/linkedin-media-failure.test.ts. Instagram has no status-discarding upload helper — it
// preserves Meta's message everywhere — but it reached the SAME wrong outcome by a different
// route: `isRetryable(code)` took Meta's APPLICATION error code and tested it against HTTP ranges
// (`code === 429 || code >= 500 || code === 2`), and every caller passed `err?.code ?? 0`.
//
// Two failures fell through it, both silent, both expensive:
//
//   • A 5xx from Meta's edge carries no `error` object, so `code` was 0 → PERMANENT. The row read
//     {"errorCode": null, "errorMessage": "Unknown error", "isRetryable": false} — the same
//     unactionable shape the X media path produced, reached from the opposite direction.
//   • A real throttle arrives as an application code, never a status: 4 (app limit), 17 (user),
//     32 (page), 613 (calls/second), 341 (app). None matched `>= 500`, so Instagram treated its own
//     rate limiting as a permanent rejection and burned the post. tests/graph-error-classification
//     already encodes this set — the two classifiers disagreed about the same API.
//
// The knock-on: handlePublishFailure gated the org-wide defer on `errorCode === 429`, comparing an
// HTTP status against an application code. It could never fire, so rate_limit_states and the
// instagram_rate_limited notification were unreachable code.
//
// NOT COVERED: the live Graph API, and the DB side of handlePublishFailure. These pin the
// classification the whole retry policy is built on.
//
// Run:  npx tsx tests/instagram-retry-classification.test.ts

import assert from 'node:assert';
import { isRetryable, isThrottle } from '../netlify/functions/publish-instagram';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nHTTP-level failures — the half that had no error object at all\n');

check('a 5xx with no error body is retryable, not a permanent burn', () => {
    // The exact shape that produced {"errorCode": null, "isRetryable": false}: Meta's edge fails
    // before the API does, so there is no code to classify on.
    for (const status of [500, 502, 503, 504]) {
        assert.equal(isRetryable(status, null), true, `HTTP ${status} must back off`);
    }
});

check('an HTTP 429 is retryable and defers the whole org', () => {
    assert.equal(isRetryable(429, null), true);
    assert.equal(isThrottle(429, null), true);
});

check('a 4xx that is not a throttle stays permanent', () => {
    for (const status of [400, 401, 403, 404, 422]) {
        assert.equal(isRetryable(status, null), false, `HTTP ${status} must not be retried blindly`);
    }
});

check('a 200 carrying no id and no error is permanent', () => {
    // Graph broke its own contract. Retrying an identical request cannot help.
    assert.equal(isRetryable(200, null), false);
});

console.log('\nMeta application codes — the half that never looked like an HTTP status\n');

check('every documented throttle code is retryable AND defers the org', () => {
    // 4/17/32/613 are the same set goal-metric-selftest treats as inconclusive; 341 is the app
    // limit. Under the old `code >= 500` test only 613 matched, and only by coincidence — it is a
    // three-digit application code that happens to sit above the HTTP 5xx floor.
    for (const code of [4, 17, 32, 341, 613]) {
        assert.equal(isRetryable(200, code), true, `Graph #${code} is a rate limit, not a rejection`);
        assert.equal(isThrottle(200, code), true, `Graph #${code} must defer the org`);
    }
});

check('a throttle reported under a 400 is still a throttle', () => {
    // Graph does not answer its limits with 429 — the status is usually 400, sometimes 200.
    assert.equal(isRetryable(400, 4), true, 'the status must not veto the application code');
    assert.equal(isThrottle(400, 613), true);
});

check('Graph\'s transient pair is retryable but does NOT defer the org', () => {
    // #1 unknown error, #2 temporary downtime — worth another attempt, but nothing is rate-limited,
    // so deferring every other post for an hour would be an overreaction.
    for (const code of [1, 2]) {
        assert.equal(isRetryable(200, code), true, `Graph #${code} is transient`);
        assert.equal(isThrottle(200, code), false, `Graph #${code} is not a rate limit`);
    }
});

check('a permanent Graph code is permanent, whatever the status', () => {
    // 190 expired token, 10 permission wall, 100 bad parameter, 368 restricted account,
    // 2207026 content policy. Retrying these wastes attempts and delays telling the user.
    for (const code of [10, 100, 190, 368, 2207026]) {
        assert.equal(isRetryable(400, code), false, `Graph #${code} must not be retried`);
        assert.equal(isThrottle(400, code), false);
    }
});

check('a 5xx wins even when Graph also sent a permanent-looking code', () => {
    // The server failed to answer properly; its code is not trustworthy evidence about the post.
    assert.equal(isRetryable(503, 100), true);
});

console.log('\nThe regression this replaces\n');

check('the old single-argument test would have burned all of these', () => {
    // Reproduces `code === 429 || code >= 500 || code === 2` against `err?.code ?? 0` — pinned so a
    // future refactor cannot quietly reintroduce comparing an application code to an HTTP range.
    const old = (code: number) => code === 429 || code >= 500 || code === 2;
    const nowRetryable: Array<[string, number | null, number | null]> = [
        ['edge 500, no error body', 500, null],
        ['edge 503, no error body', 503, null],
        ['#4 app request limit',    400, 4],
        ['#17 user request limit',  400, 17],
        ['#32 page request limit',  400, 32],
        ['#341 app limit reached',  400, 341],
        ['#1 unknown error',        200, 1],
    ];
    // #613 is deliberately absent: the old test DID catch it, because 613 ≥ 500 by coincidence.
    // That accident is worth naming — it is why the bug looked half-working rather than broken.
    assert.equal(old(613), true, 'precondition: #613 was the one throttle the old test caught');
    for (const [label, status, code] of nowRetryable) {
        assert.equal(old(code ?? 0), false, `precondition: the old test lost ${label}`);
        assert.equal(isRetryable(status, code), true, `${label} must now be retryable`);
    }
});

check('nothing that was retryable before became permanent', () => {
    // The fix must only ever widen. #2 was the one code the old test caught; it still holds.
    assert.equal(isRetryable(200, 2), true);
    assert.equal(isRetryable(429, null), true);
});

console.log(`\n${passed} passed\n`);
