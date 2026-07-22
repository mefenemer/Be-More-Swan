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

console.log(`\n${passed} passed, 0 failed\n`);
