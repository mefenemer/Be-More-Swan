// tests/login-link.test.ts
// A login link logs in without a click only in the browser that asked for it, so an email scanner
// that opens the page and runs its script can't spend the token. See src/utils/login-link.ts.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

import {
    LOGIN_BROWSER_COOKIE, isSameLoginBrowser, loginBrowserCookie, loginLinkParams, maskEmail, readLoginRef, sessionUserId,
} from '../src/utils/login-link';

process.env.JWT_SECRET = 'test-secret-for-login-link'; // read at call time

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const paramsOf = (query: string) => new URLSearchParams(query.slice(1));

// 1. The browser that asked passes. Nothing else does.
{
    const { value, setCookie } = loginBrowserCookie(undefined);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/\.netlify\/functions/);

    const cookie = `other=1; ${LOGIN_BROWSER_COOKIE}=${value}`;
    const proof = paramsOf(loginLinkParams({ plainToken: 'tok', userId: 7, browser: value })).get('b');
    assert.ok(proof);
    assert.strictEqual(isSameLoginBrowser(cookie, 'tok', proof), true, 'same browser, same token');
    assert.strictEqual(isSameLoginBrowser(undefined, 'tok', proof), false, 'a scanner has no cookie');
    assert.strictEqual(isSameLoginBrowser(`${LOGIN_BROWSER_COOKIE}=${'0'.repeat(64)}`, 'tok', proof), false, 'another browser');
    assert.strictEqual(isSameLoginBrowser(cookie, 'other-token', proof), false, 'proof is bound to its token');
    assert.strictEqual(isSameLoginBrowser(cookie, 'tok', undefined), false, 'a link with no proof');
    assert.strictEqual(isSameLoginBrowser(cookie, 'tok', 'short'), false, 'a bad proof does not throw');
}

// 2. A repeat request keeps the cookie, so an earlier link still works if this one was rate-limited.
{
    const first = loginBrowserCookie(undefined);
    assert.strictEqual(loginBrowserCookie(`${LOGIN_BROWSER_COOKIE}=${first.value}`).value, first.value);
    assert.notStrictEqual(loginBrowserCookie(`${LOGIN_BROWSER_COOKIE}=not-ours`).value, 'not-ours');
}

// 3. The account reference can't be forged or moved to another account.
{
    const ref = paramsOf(loginLinkParams({ plainToken: 'tok', userId: 42 })).get('r')!;
    assert.strictEqual(readLoginRef(ref), 42);
    assert.strictEqual(readLoginRef(ref.replace(/^42/, '43')), null);
    for (const bad of ['42', '42.abc', '', null, undefined, 42, { id: 42 }]) {
        assert.strictEqual(readLoginRef(bad), null, `rejects ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(paramsOf(loginLinkParams({ plainToken: 'tok', userId: 42 })).get('b'), null, 'no asker, no proof');
}

// 4. Session check: signature matters, as it decides who skips the Continue button.
{
    const good = jwt.sign({ userId: 5 }, process.env.JWT_SECRET!);
    assert.strictEqual(sessionUserId(`a=b; aura_session=${good}`), 5);
    assert.strictEqual(sessionUserId(`aura_session=${jwt.sign({ userId: 5 }, 'wrong-secret')}`), null);
    assert.strictEqual(sessionUserId(undefined), null);
}

// 5. Masking
assert.strictEqual(maskEmail('catherine@hotmail.co.uk'), 'c•••@hotmail.co.uk');
assert.strictEqual(maskEmail('nonsense'), '•••');

// 6. verify.ts: the check on load comes before anything that spends the token or logs in.
{
    const verify = read('netlify/functions/verify.ts');
    const gate = verify.indexOf('body.auto === true && !provenOnLoad');
    const spend = verify.indexOf("status: 'active', verificationToken: null");
    const session = verify.indexOf('jwt.sign(tokenPayload');
    assert.ok(gate > 0 && spend > 0 && session > 0, 'markers still exist');
    assert.ok(gate < spend, 'scanner stops before the token is spent');
    assert.ok(gate < session, 'scanner stops before a session is made');
}

// 7. The page never spends on load without asking for the check, and says so to the server.
{
    const page = read('verify-account.html');
    assert.ok(page.includes('logIn(true);'), 'load runs the check');
    assert.ok(page.includes('logIn(false);'), 'only the click skips it');
    assert.strictEqual(page.match(/logIn\(false\)/g)?.length, 1);
    assert.ok(/continueBtn\.addEventListener\('click'[\s\S]{0,80}logIn\(false\)/.test(page));
}

// 8. Every sender of this page's links signs them, so recovery works from any of those emails.
for (const fn of ['login', 'register', 'resend-verification', 'admin-api', 'onboarding-reminder']) {
    assert.ok(read(`netlify/functions/${fn}.ts`).includes('loginLinkParams('), `${fn} signs its link`);
}

// 9. Set for known and unknown addresses alike, so the cookie reveals nothing about an account.
{
    const login = read('netlify/functions/login.ts');
    assert.strictEqual(login.match(/statusCode: 200, headers: answered/g)?.length, 2, 'rate-limited and normal answers');
    const resend = read('netlify/functions/resend-verification.ts');
    assert.strictEqual(resend.match(/'Set-Cookie': browser\.setCookie/g)?.length, 2);
}

console.log('login-link: all checks passed');
