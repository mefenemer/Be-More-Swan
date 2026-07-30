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
import { matchesSearchedUrl } from '../netlify/functions/verify-compliance-warning';

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

// ── Staying inside the request's time budget ────────────────────────────────────────────────────
// "AI Resolve" reported "Could not run the check." with no explanation, and the wording was the
// giveaway: it was the BROWSER's fallback string, not the handler's message, which means the
// response carried no JSON at all. Netlify kills a synchronous function at 26s and its kill has no
// body, so an overrunning handler cannot report anything — its own try/catch never runs.
//
// gatewayGenerateGrounded can make five model calls (primary, failover, three pause_turn resumes)
// at a 24s client ceiling each. Callers on a request path must therefore bound it, and the bound
// has to leave room to serialise a reply.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.join(__dirname, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

check('the grounded call is bounded, and bounded well inside the 26s function cap', () => {
    const fn = readSrc('netlify/functions/verify-compliance-warning.ts');
    const budget = fn.match(/deadlineMs:\s*([0-9_]+)/);
    assert.ok(budget, 'verify-compliance-warning must pass a deadlineMs — unbounded, it can outlive the request');
    const ms = Number(budget![1].replace(/_/g, ''));
    assert.ok(ms <= 22_000,
        `a ${ms}ms budget leaves too little of the 26s cap to serialise a reply — the client would get a bodyless 502`);

    const gw = readSrc('src/lib/ai-gateway.ts');
    assert.match(gw, /deadlineMs\?: number/, 'GatewayRequest must accept a budget');
    // The budget is worthless unless the OPTIONAL calls consult it: a failover and each resume are
    // full extra calls, and they are what turn one slow answer into an overrun.
    const grounded = gw.slice(gw.indexOf('export async function gatewayGenerateGrounded'));
    assert.match(grounded, /if \(remaining\(\) < MIN_CALL_MS\)[\s\S]{0,400}throw primaryErr/,
        'a failover with no budget left must surface the original error rather than overrun');
    assert.match(grounded, /for \([^)]*pause_turn[^)]*\) \{\s*if \(remaining\(\) < MIN_CALL_MS\)/,
        'each pause_turn resume must check the budget before starting another call');
});

check('a timeout is reported as itself, not as a generic failure', () => {
    const fn = readSrc('netlify/functions/verify-compliance-warning.ts');
    assert.match(fn, /APIConnectionTimeoutError/,
        'the catch must recognise a timeout — it is a recurring outcome, not an unknown error');
    assert.match(fn, /VERIFY_TIMEOUT/, 'a timeout needs its own code so the UI can say what happened');
    // And it must still be JSON: the browser only falls back to its generic string when the body
    // has no `error` field.
    assert.match(fn, /json\(504, \{/, 'the timeout branch must return a JSON body, never a bare status');
});

console.log(`\n${passed} passed, 0 failed\n`);
