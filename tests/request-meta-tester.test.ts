// tests/request-meta-tester.test.ts
// The "add me as a Meta Tester" request: netlify/functions/request-meta-tester.ts + the pre-connect
// modal in integrations.js / assistant-detail.html.
//
// The trap this guards: a SHARE link resolves to the person's Page, which cannot hold an app role,
// so inviting it leaves a Pending row forever with nothing to accept (2026-09-06). It must be
// refused with an explanation, not accepted. No network, no database.
//
// Run:  npx tsx tests/request-meta-tester.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFacebookProfile } from '../netlify/functions/request-meta-tester';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const accepts = (input: string, expected: string) => {
    const r = checkFacebookProfile(input);
    assert.ok(r.ok, `rejected ${input}: ${!r.ok && r.error}`);
    assert.equal(r.ok && r.value, expected);
};
const rejects = (input: unknown, pattern: RegExp) => {
    const r = checkFacebookProfile(input);
    assert.ok(!r.ok, `accepted ${String(input)}`);
    assert.match(!r.ok ? r.error : '', pattern);
};

console.log('checkFacebookProfile');
check('a vanity profile URL is normalised to www.facebook.com', () =>
    accepts('https://m.facebook.com/jane.smith/', 'https://www.facebook.com/jane.smith'));
check('a profile.php?id= URL keeps its id', () =>
    accepts('facebook.com/profile.php?id=61593831584751', 'https://www.facebook.com/profile.php?id=61593831584751'));
check('a bare numeric id is accepted as-is', () => accepts('61593831584751', '61593831584751'));
check('a SHARE link is refused, explaining it points at the Page', () =>
    rejects('https://www.facebook.com/share/1AbCdEf/', /Share links point at your Page/));
check('facebook.com/me itself is refused (it is the instruction, not the answer)', () =>
    rejects('https://www.facebook.com/me', /copy THAT address/));
check('a non-Facebook host is refused', () => rejects('https://instagram.com/jane', /not a facebook\.com link/));
check('a look-alike host is refused', () => rejects('https://facebook.com.evil.example/jane', /not a facebook\.com link/));
check('profile.php without a numeric id is refused', () => rejects('https://facebook.com/profile.php', /missing its id/));
check('empty input is refused', () => rejects('  ', /facebook\.com\/me/));
check('non-string input does not throw', () => rejects(undefined, /facebook\.com\/me/));

console.log('wiring');
check('the endpoint records a ticket before emailing, and a failed email does not fail it', () => {
    const src = read('netlify/functions/request-meta-tester.ts');
    assert.ok(src.indexOf('insert(supportTickets)') > 0);
    assert.ok(src.indexOf('insert(supportTickets)') < src.indexOf('await sendEmail('));
    assert.ok(src.includes("founder email failed — request is in support_tickets"));
});
check('only Facebook and Instagram are marked metaApp', () => {
    const js = read('integrations.js');
    assert.equal(js.match(/metaApp: true/g)?.length, 2);
    assert.ok(js.includes("action=start&platform=facebook',\n        metaApp: true"));
    assert.ok(js.includes("action=start&platform=instagram',\n        metaApp: true"));
});
check('the modal shows the tester box only in tester mode, and Continue stays reachable', () => {
    const js = read('integrations.js');
    assert.ok(js.includes('const testerMode = META_REVIEW_PENDING && !!platform.metaApp;'));
    assert.ok(js.includes("testerEl.style.display = testerMode ? '' : 'none';"));
    assert.ok(js.includes('Already added as a tester? Continue to'));
});
check('the markup the controller reads exists, hidden by default', () => {
    const html = read('assistant-detail.html');
    for (const id of ['preconnect-tester', 'preconnect-tester-url', 'btn-preconnect-tester', 'preconnect-tester-status']) {
        assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert.ok(html.includes('id="preconnect-tester" class="hidden'));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
