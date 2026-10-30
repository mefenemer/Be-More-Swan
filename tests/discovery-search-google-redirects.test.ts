// tests/discovery-search-google-redirects.test.ts
// Google's `google.com/goto` redirect links must never reach a consumer as "google.com".
//
// ── What this fixes ──────────────────────────────────────────────────────────
// Found 2026-10-30: Serper now passes Google's opaque `https://www.google.com/goto?url=CAES…`
// wrappers through as the organic `link` for 5–7 of every 10 results. Taken at face value each
// became the domain `google.com` — the domain filter let it through, so a campaign could file a
// "lead" called after some other business with google.com as its site, and buying-signal evidence
// linked nowhere. src/lib/discovery-search.ts now rebuilds the SITE from Google's displayed address
// (exactUrl:false) or drops the row; consumers that need the exact page skip rebuilt rows.
// Nothing requests Google to resolve the token — most answers are a bot-check page.
//
// Run:  npx tsx tests/discovery-search-google-redirects.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostFromDisplayedLink, isGoogleRedirect, serperOrganicToResult } from '../src/lib/discovery-search';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const GOTO = 'https://www.google.com/goto?url=CAESngEB6zswFZ0t7HiR1udDYDjW6NTfFfpT1qot08PAXn3m';

check('only Google’s redirect wrappers count as redirects', () => {
    assert.strictEqual(isGoogleRedirect(GOTO), true);
    assert.strictEqual(isGoogleRedirect('https://www.google.co.uk/url?q=x'), true);
    assert.strictEqual(isGoogleRedirect('https://books.google.com/books?id=1'), false);
    assert.strictEqual(isGoogleRedirect('https://www.reddit.com/r/x/comments/1/goto'), false);
    assert.strictEqual(isGoogleRedirect('https://goto.com/'), false);
    assert.strictEqual(isGoogleRedirect(undefined), false);
});

check('the site is read from Google’s displayed address, and only from a real address', () => {
    assert.strictEqual(hostFromDisplayedLink('https://bhp.co.uk › office › leeds'), 'bhp.co.uk');
    assert.strictEqual(hostFromDisplayedLink('https://www.forrester-boyd.co.uk › offices › leeds-acco...'), 'www.forrester-boyd.co.uk');
    assert.strictEqual(hostFromDisplayedLink('https://pipeworksmanchesterltd.co.uk'), 'pipeworksmanchesterltd.co.uk');
    assert.strictEqual(hostFromDisplayedLink('570+ comments  ·  1 week ago'), null);
    assert.strictEqual(hostFromDisplayedLink('20.4M+ followers'), null);
    assert.strictEqual(hostFromDisplayedLink('https://www.google.com › maps'), null);
});

check('a redirect row becomes the site, marked not-exact; a plain row is untouched', () => {
    const r = serperOrganicToResult({ title: 'Leeds Accountants', link: GOTO, displayedLink: 'https://www.djh.co.uk › Offices', snippet: 's', date: '3 days ago' });
    assert.deepStrictEqual(r, { title: 'Leeds Accountants', url: 'https://www.djh.co.uk/', snippet: 's', domain: 'djh.co.uk', date: '3 days ago', exactUrl: false });
    const p = serperOrganicToResult({ title: 't', link: 'https://www.saffery.com/offices/accountants-leeds/', snippet: '' });
    assert.strictEqual(p?.domain, 'saffery.com');
    assert.strictEqual(p?.exactUrl, undefined);
});

check('a redirect row with no site shown is dropped — never "google.com"', () => {
    assert.strictEqual(serperOrganicToResult({ title: 'r/Documentaries', link: GOTO, displayedLink: '20.4M+ followers' }), null);
    assert.strictEqual(serperOrganicToResult({ title: 'x', link: GOTO }), null);
});

check('consumers that need the exact page skip rebuilt rows', () => {
    assert.match(read('src/lib/lead-intel.ts'), /if \(r\.exactUrl !== false\) evidence\.push/);
    assert.match(read('src/utils/discussions.ts'), /if \(r\.exactUrl === false\) continue;/);
    assert.match(read('src/lib/discovery-search.ts'), /organic\.slice\(0, limit\)\.map\(serperOrganicToResult\)/);
});

check('nothing requests Google to resolve a redirect', () => {
    const s = read('src/lib/discovery-search.ts');
    assert.doesNotMatch(s, /fetch\([^)]*goto/);
    assert.doesNotMatch(s, /redirect:\s*'manual'/);
});

console.log(`\n${passed}/${total} passed`);
