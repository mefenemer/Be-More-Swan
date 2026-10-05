// tests/register-keeps-session.test.ts
//
// Run:  npx tsx tests/register-keeps-session.test.ts
//
// register.html clears local auth state on load, and aura_session is readable by page script — so an
// unconditional clear logged out ANYONE who merely opened /register (an existing customer on a "Get
// Started" link, a beta tester's sign-up link in a logged-in browser). It wiped the founder's live
// session on 2026-10-05. The clear must only run once the server has said "not signed in".

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(root, 'register.html'), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('the session cookie is only cleared after a signed-in check, and never for a signed-in visitor', () => {
    const ask = landmark(PAGE, "fetch('/.netlify/functions/check-capacity'");
    const bail = landmark(PAGE, 'if (signedIn) {', ask);
    const ret = landmark(PAGE, 'return;', bail);
    const clear = landmark(PAGE, 'document.cookie = "aura_session=;');
    assert.ok(ask < bail && bail < ret && ret < clear,
        'aura_session is cleared before (or without) asking whether the visitor is signed in — opening /register logs people out again');
    assert.strictEqual(PAGE.split('localStorage.clear()').length - 1, 1, 'exactly one localStorage.clear(), the guarded one');
});

check('a signed-in visitor is shown the "already signed in" panel instead of the form', () => {
    assert.match(PAGE, /id="signedInPanel"/);
    assert.match(PAGE, /href="\/workspace\.html"[^>]*>Go to your workspace/);
});

if (process.exitCode) console.error('\nregister keeps session: FAILED');
else console.log(`\nregister keeps session: ${passed} passed`);
