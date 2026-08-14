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
import { isRetryable, isThrottle, waitForContainerReady } from '../netlify/functions/publish-instagram';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const checks: Array<Promise<void>> = [];
function checkAsync(name: string, fn: () => Promise<void>): void {
    checks.push(fn().then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        err => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; },
    ));
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

// ── #9007: the container that wasn't ready yet ──────────────────────────────────────────────────
// Prod post 362 (2026-08-13, assistant 1, format IMAGE) failed with
//   {"errorCode": 9007, "httpStatus": 400, "isRetryable": false,
//    "errorMessage": "Media ID is not available", "errorSubcode": 2207027}
// and was never retried. Nothing was wrong with the post: media_publish simply arrived before the
// container finished processing. A 400 made it look permanent, so one lost race burned the post on
// attempt 1 of 3.

console.log('\nContainer readiness\n');

check('#9007 is a timing failure, so it retries', () => {
    assert.equal(isRetryable(400, 9007), true, 'the exact prod shape must now back off and retry');
    // Not a throttle — deferring the whole org for an hour over one slow container is an
    // overreaction, and would delay every other post that was fine.
    assert.equal(isThrottle(400, 9007), false);
});

check('the content-policy subcode next door stays permanent', () => {
    // 2207026 and 2207027 differ by one digit and mean opposite things: a rejected post that will
    // never publish, versus a container that just needs a moment. Retrying the first is pure waste.
    assert.equal(isRetryable(400, 2207026), false);
});

checkAsync('an image container is checked IMMEDIATELY, not after a wait', async () => {
    // The whole point of a separate image profile: the container is normally ready the instant it
    // exists, so the common case must not pay a poll interval before publishing.
    const sleeps: number[] = [];
    let polls = 0;
    const r = await waitForContainerReady({
        containerId: 'c1', token: 't', firstDelayMs: 0, intervalMs: 1_000, timeoutMs: 30_000, what: 'Image processing',
        sleep: async ms => { sleeps.push(ms); },
        poll: async () => { polls++; return { status: 200, status_code: 'FINISHED' }; },
    });
    assert.deepEqual(r, { ok: true });
    assert.equal(polls, 1, 'one request');
    assert.deepEqual(sleeps, [], 'and no waiting at all');
});

checkAsync('a container that needs a moment is waited for, then published', async () => {
    const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const sleeps: number[] = [];
    const r = await waitForContainerReady({
        containerId: 'c1', token: 't', firstDelayMs: 0, intervalMs: 1_000, timeoutMs: 30_000, what: 'Image processing',
        sleep: async ms => { sleeps.push(ms); },
        poll: async () => ({ status: 200, status_code: statuses.shift() }),
    });
    assert.deepEqual(r, { ok: true });
    // Immediate first check, then the interval between subsequent ones.
    assert.deepEqual(sleeps, [1_000, 1_000]);
});

checkAsync('the video profile still waits 5s before its first check', async () => {
    // Encoding takes real time; polling a video container instantly is a wasted request. This pins
    // that the shared helper did not quietly change video behaviour.
    const sleeps: number[] = [];
    await waitForContainerReady({
        containerId: 'c1', token: 't', firstDelayMs: 5_000, intervalMs: 5_000, timeoutMs: 120_000, what: 'Video processing',
        sleep: async ms => { sleeps.push(ms); },
        poll: async () => ({ status: 200, status_code: 'FINISHED' }),
    });
    assert.deepEqual(sleeps, [5_000]);
});

checkAsync('a container Instagram rejected outright is permanent', async () => {
    const r = await waitForContainerReady({
        containerId: 'c1', token: 't', firstDelayMs: 0, intervalMs: 1, timeoutMs: 30_000, what: 'Image processing',
        sleep: async () => {},
        poll: async () => ({ status: 400, status_code: 'ERROR', error: { code: 2207026, message: 'Content policy', error_subcode: 2207026 } }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason.isRetryable, false, 're-uploading the same file cannot succeed');
});

checkAsync('a clean read with no status_code means ready, not broken', async () => {
    // Images were never polled before this change, so there is no evidence an IMAGE container even
    // reports status_code on this Graph version. If the field's absence read as ERROR, adding a
    // health check would fail EVERY image post — strictly worse than the race it set out to fix.
    // Silence on a 2xx therefore means "carry on", which is exactly the old image behaviour.
    const r = await waitForContainerReady({
        containerId: 'c1', token: 't', firstDelayMs: 0, intervalMs: 1, timeoutMs: 30_000, what: 'Image processing',
        sleep: async () => {},
        poll: async () => ({ status: 200 }),      // no status_code, no error
    });
    assert.deepEqual(r, { ok: true });
});

checkAsync('but an error object on a 200 is still an error', async () => {
    const r = await waitForContainerReady({
        containerId: 'c1', token: 't', firstDelayMs: 0, intervalMs: 1, timeoutMs: 30_000, what: 'Image processing',
        sleep: async () => {},
        poll: async () => ({ status: 200, error: { code: 10, message: 'No permission' } }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason.isRetryable, false);
});

checkAsync('a 5xx on the STATUS read is not evidence about the container', async () => {
    const r = await waitForContainerReady({
        containerId: 'c1', token: 't', firstDelayMs: 0, intervalMs: 1, timeoutMs: 30_000, what: 'Image processing',
        sleep: async () => {},
        poll: async () => ({ status: 503 }),      // no status_code, no error object
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason.isRetryable, true, 'we failed to REACH Graph, that is all');
});

checkAsync('a container that never finishes times out, and the timeout retries', async () => {
    const r = await waitForContainerReady({
        containerId: 'c1', token: 't', firstDelayMs: 0, intervalMs: 5, timeoutMs: 1_000, what: 'Image processing',
        poll: async () => ({ status: 200, status_code: 'IN_PROGRESS' }),
    });
    assert.equal(r.ok, false);
    // Retryable on purpose: a container still encoding says nothing bad about the post.
    assert.equal(r.ok === false && r.reason.isRetryable, true);
    assert.match(r.ok === false ? r.reason.errorMessage : '', /Image processing timed out after 1s/);
});

void Promise.all(checks).then(() => console.log(`\n${passed} passed\n`));
