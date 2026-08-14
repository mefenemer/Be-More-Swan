// tests/compliance-verification.test.ts
// Locks the grounding check that stops the compliance verifier filing a fabricated citation.
// Run:  npx tsx tests/compliance-verification.test.ts
//
// Why this matters more than it looks: a model asked to "verify this statistic" will produce a
// confident, correctly-formatted URL to a study that does not exist. In a compliance control that
// is worse than no answer — it launders an unverified claim into a filed one with a real person's
// name against it. matchesSearchedUrl is the check that only lets through URLs the web_search tool
// actually returned, and it must return the SEARCHED url rather than the model's rendering of it.

import assert from 'node:assert';
import { matchesSearchedUrl } from '../src/utils/compliance-verification';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const RESULTS = [
    'https://example.gov/reports/smb-software-2026',
    'https://research.example.org/subscriptions/',
];

check('an exact hit from the search results is accepted', () => {
    assert.equal(
        matchesSearchedUrl('https://example.gov/reports/smb-software-2026', RESULTS),
        'https://example.gov/reports/smb-software-2026',
    );
});

check('a plausible URL the model invented is rejected', () => {
    // The fabrication case: right domain shape, real-looking path, never appeared in any result.
    assert.equal(matchesSearchedUrl('https://example.gov/reports/smb-software-2025', RESULTS), null);
    assert.equal(matchesSearchedUrl('https://mckinsey.com/smb-saas-study', RESULTS), null);
});

check('nothing is accepted when no search returned anything', () => {
    assert.equal(matchesSearchedUrl('https://example.gov/reports/smb-software-2026', []), null);
});

check('a stripped query string still matches its result', () => {
    // Models routinely drop tracking params when quoting a URL back.
    assert.equal(
        matchesSearchedUrl('https://example.gov/reports/smb-software-2026?utm_source=x', RESULTS),
        'https://example.gov/reports/smb-software-2026',
    );
});

check('a trailing slash difference still matches', () => {
    assert.equal(
        matchesSearchedUrl('https://research.example.org/subscriptions', RESULTS),
        'https://research.example.org/subscriptions/',
    );
});

check('a different page on a domain that appeared is NOT accepted', () => {
    // The subtle one. The host was in the results, so a host-only check would wave this through —
    // letting the model cite any page it likes on any site the search happened to touch.
    assert.equal(matchesSearchedUrl('https://example.gov/reports/something-else', RESULTS), null);
    assert.equal(matchesSearchedUrl('https://example.gov/', RESULTS), null);
});

check('non-http schemes and junk are rejected', () => {
    assert.equal(matchesSearchedUrl('javascript:alert(1)', RESULTS), null);
    assert.equal(matchesSearchedUrl('file:///etc/passwd', RESULTS), null);
    assert.equal(matchesSearchedUrl('not a url', RESULTS), null);
    assert.equal(matchesSearchedUrl('', RESULTS), null);
});

check('an unparseable entry in the results does not break the comparison', () => {
    assert.equal(
        matchesSearchedUrl('https://example.gov/reports/smb-software-2026', ['', 'garbage', ...RESULTS]),
        'https://example.gov/reports/smb-software-2026',
    );
});


// ── The work does not fit in a request, and must not be attempted there ────────────────────────
// "AI Resolve" reported "Could not run the check." with no explanation, and the wording was the
// giveaway: it was the BROWSER's fallback string, not the handler's message, which means the
// response carried no JSON at all. Netlify kills a synchronous function at 26s and its kill has no
// body, so an overrunning handler cannot report anything — its own try/catch never runs.
//
// Two measurements settle the design, and both are easy to forget later:
//   • A real verification took 124 SECONDS (4 web searches + dynamic filtering + reasoning). No
//     amount of bounding fits that into 26s — bounding only converts a mysterious failure into a
//     reliable one.
//   • The first fix bounded the call with `deadlineMs: 20_000` and still overran, at 61 SECONDS.
//     The SDK's `timeout` is PER ATTEMPT and it retries a connection timeout twice by default, so
//     one bounded call was silently three.
//
// So the work lives in a `-background` worker (15-minute ceiling) and the request only starts it.
import fs from 'node:fs';
import path from 'node:path';
import { landmark } from './landmark';
const ROOT = path.join(__dirname, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

check('a deadline also disables SDK retries, or it is not a deadline', () => {
    const gw = readSrc('src/lib/ai-gateway.ts');
    const grounded = gw.slice(landmark(gw, 'export async function gatewayGenerateGrounded'));
    // The measured 3x. `timeout` alone bounds an ATTEMPT; only maxRetries bounds the call.
    assert.match(grounded, /timeout: Math\.max\(MIN_CALL_MS, left\),[\s\S]{0,600}maxRetries: 0/,
        'a per-request timeout must be paired with maxRetries: 0 — the SDK retries timeouts twice, tripling the budget');
    // The budget is still worthless unless the OPTIONAL calls consult it: a failover and each
    // resume are full extra calls, and they are what turn one slow answer into an overrun.
    assert.match(grounded, /if \(remaining\(\) < MIN_CALL_MS\)[\s\S]{0,400}throw primaryErr/,
        'a failover with no budget left must surface the original error rather than overrun');
    assert.match(grounded, /for \([^)]*pause_turn[^)]*\) \{\s*if \(remaining\(\) < MIN_CALL_MS\)/,
        'each pause_turn resume must check the budget before starting another call');
});

check('the request path starts the work, it does not do it', () => {
    const fn = readSrc('netlify/functions/verify-compliance-warning.ts');
    assert.doesNotMatch(fn, /gatewayGenerateGrounded|runWarningVerification\(/,
        'the endpoint must never run the verification inline — it cannot finish inside the 26s cap');
    assert.match(fn, /triggerWarningVerification\(/, 'it must dispatch the background worker');
    assert.match(fn, /json\(202, \{ status: 'running' \}\)/,
        'the caller needs a status it can poll, not a result it will never get');
    // The credit is charged here, so a click that dispatches nothing must not leave a spinner.
    assert.match(fn, /if \(!dispatched\.ok\)[\s\S]{0,600}status: 'failed'/,
        'a failed dispatch must be recorded as failed, not left running forever');
});

check('the worker is a real background function, and is not open to the internet', () => {
    const worker = readSrc('netlify/functions/verify-compliance-warning-background.ts');
    assert.match(worker, /CRON_TRIGGER_SECRET/, 'the worker spends model credits and paid searches — it must be gated');
    assert.match(worker, /statusCode: 401|json\(401,/, 'a bad secret must be rejected');
    assert.match(worker, /runWarningVerification\(/, 'the worker is where the verification actually runs');
    // It must re-check rather than trust the trigger: the caption can change between the click and
    // the write, and a proposal about text that no longer exists must be dropped, not filed.
    assert.match(worker, /readCachedReview\(/, 'the worker must re-validate the review before spending anything');

    const trigger = readSrc('src/utils/trigger-verification.ts');
    assert.match(trigger, /await fetch\(/,
        'the trigger MUST be awaited — Lambda freezes on return and an un-awaited fetch never leaves the sandbox');
});

check('the verification budget suits a background worker, not a request', () => {
    const core = readSrc('src/utils/compliance-verification.ts');
    const budget = core.match(/VERIFY_DEADLINE_MS = ([0-9_]+)/);
    assert.ok(budget, 'the verification must carry an explicit budget');
    const ms = Number(budget![1].replace(/_/g, ''));
    // Measured at ~124s. Below that it can only ever time out; the client's 24s default is the trap.
    assert.ok(ms >= 150_000, `a ${ms}ms budget cannot finish work measured at ~124s`);
    assert.ok(ms <= 600_000, `a ${ms}ms budget risks outliving the worker's own 15-minute ceiling`);
});

check('a stalled run cannot spin forever', () => {
    const pqr = readSrc('src/utils/post-quality-review.ts');
    assert.match(pqr, /VERIFICATION_STALE_MS/,
        'a worker that dies writes nothing — a running marker needs an expiry or the warning spins forever');
    const fn = readSrc('netlify/functions/verify-compliance-warning.ts');
    assert.match(fn, /isVerificationInFlight\(/,
        'the endpoint must expire an abandoned run so the user can retry');
    const ui = readSrc('workspace.html');
    assert.match(ui, /PRQ_POLL_MAX/, 'the client needs its own cap so a lost worker stops the spinner');
    assert.match(ui, /poll: 1/, 'the panel polls for the result rather than waiting on one response');
});

console.log(`\n${passed} passed, 0 failed\n`);
