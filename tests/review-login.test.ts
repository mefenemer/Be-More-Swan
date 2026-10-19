// tests/review-login.test.ts
// A password login is a door in a product that otherwise has none.
//
// review-login.ts exists so Google's OAuth reviewers can sign in without a mailbox — magic links
// were the "authentication blocker" their rejection named. The whole safety case rests on it being
// DARK unless deliberately configured, and on it being switchable off from Netlify's env panel
// without a deploy. These checks pin that shut. The gate is a pure function precisely so it can be
// proved here without a database, a Request or a deploy.
//
// ⚠️ The most dangerous case is a MALFORMED expiry date. If an unreadable value were treated as
// "no expiry", a typo in REVIEW_LOGIN_EXPIRES would silently turn a temporary reviewer credential
// into a permanent backdoor — a fault that looks like nothing at all until it is found by someone
// else. It must read as EXPIRED.
//
// Run:  npx tsx tests/review-login.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    resolveReviewConfig, resolveEnabledReviewers, MIN_SECRET_LEN, DEFAULT_REVIEW_EMAIL,
    DEFAULT_META_REVIEW_EMAIL, REVIEW_SLOTS,
} from '../netlify/functions/review-login';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const FN = read('netlify/functions/review-login.ts');
const PAGE = read('review-login.html');
const LOGIN = read('login.html');
const VERIFY = read('netlify/functions/verify.ts');

const STRONG = 'x'.repeat(MIN_SECRET_LEN);

console.log('\n──── dark unless deliberately switched on ────');

check('no env at all means no endpoint', () => {
    // ⚠️ The address defaults (DEFAULT_REVIEW_EMAIL) but the secret does NOT. A deployment that
    // sets nothing must still refuse every request — the default address must never be enough.
    const cfg = resolveReviewConfig({});
    assert.equal(cfg.enabled, false, 'an unconfigured deployment must not accept passwords');
    assert.equal(cfg.enabled === false && cfg.reason, 'unconfigured');
});

check('deleting the password is the off switch', () => {
    // The documented teardown is to delete REVIEW_LOGIN_PASSWORD in Netlify — no deploy, no code
    // change. Since the address is hardcoded, this is the ONLY lock, so it has to hold alone.
    assert.equal(resolveReviewConfig({ REVIEW_LOGIN_PASSWORD: STRONG }).enabled, true,
        'the password alone must be enough to switch it on, since the address defaults');
    assert.equal(resolveReviewConfig({ REVIEW_LOGIN_PASSWORD: '' }).enabled, false,
        'and clearing it must close the door');
    assert.equal(resolveReviewConfig({}).enabled, false);
});

check('the address defaults to the review account, and is still overridable', () => {
    const cfg = resolveReviewConfig({ REVIEW_LOGIN_PASSWORD: STRONG });
    assert.equal(cfg.enabled === true && cfg.email, DEFAULT_REVIEW_EMAIL,
        'an unset REVIEW_LOGIN_EMAIL must fall back to the hardcoded review account');
    assert.match(DEFAULT_REVIEW_EMAIL, /^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'and it must be a real address');
    const over = resolveReviewConfig({ REVIEW_LOGIN_EMAIL: 'other@example.com', REVIEW_LOGIN_PASSWORD: STRONG });
    assert.equal(over.enabled === true && over.email, 'other@example.com',
        'the env var must still win, so the account can move without a deploy');
});

check('a weak secret keeps it dark rather than accepting it', () => {
    const short = { REVIEW_LOGIN_PASSWORD: 'x'.repeat(MIN_SECRET_LEN - 1) };
    const cfg = resolveReviewConfig(short);
    assert.equal(cfg.enabled, false, 'a guessable password must disable the endpoint, not enable it');
    assert.equal(cfg.enabled === false && cfg.reason, 'weak_secret');
    assert.equal(resolveReviewConfig({ ...short, REVIEW_LOGIN_PASSWORD: STRONG }).enabled, true,
        'and exactly the minimum length must be accepted, or the boundary is off by one');
});

console.log('\n──── the expiry fails CLOSED ────');

check('a past expiry closes the door', () => {
    const cfg = resolveReviewConfig({
        REVIEW_LOGIN_PASSWORD: STRONG, REVIEW_LOGIN_EXPIRES: '2020-01-01',
    });
    assert.equal(cfg.enabled, false, 'an elapsed review window must switch the endpoint off by itself');
    assert.equal(cfg.enabled === false && cfg.reason, 'expired');
});

check('an unreadable expiry is treated as expired, never as "no expiry"', () => {
    // ⚠️ The one that matters. `new Date('next tuesday')` is Invalid Date, and a truthiness check
    // on it passes — so the naive version of this code silently grants permanent access.
    for (const bad of ['next tuesday', '2026-13-45', 'soon', '??']) {
        const cfg = resolveReviewConfig({
            REVIEW_LOGIN_PASSWORD: STRONG, REVIEW_LOGIN_EXPIRES: bad,
        });
        assert.equal(cfg.enabled, false, `a typo (${bad}) must not extend the credential`);
        assert.equal(cfg.enabled === false && cfg.reason, 'bad_expiry');
    }
});

check('a future expiry stays open, and an empty one means no deadline', () => {
    const base = { REVIEW_LOGIN_PASSWORD: STRONG };
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    assert.equal(resolveReviewConfig({ ...base, REVIEW_LOGIN_EXPIRES: future }).enabled, true);
    assert.equal(resolveReviewConfig({ ...base, REVIEW_LOGIN_EXPIRES: '   ' }).enabled, true,
        'whitespace must read as "unset", not as an unparseable date');
});

console.log('\n──── one account, and only one ────');

check('the address is normalised the way the caller\'s is', () => {
    // The handler lowercases and trims what the caller sends. If the env value were not put
    // through the same treatment, a stored "  Reviewer@Example.com " would never match anything
    // and the credentials would appear simply not to work.
    const cfg = resolveReviewConfig({
        REVIEW_LOGIN_EMAIL: '  Reviewer@Example.COM  ', REVIEW_LOGIN_PASSWORD: STRONG,
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.enabled === true && cfg.email, 'reviewer@example.com');
});

check('there is no lookup path to any user but the configured one', () => {
    // The DB query must key off the ENV address, never the caller-supplied one — otherwise a
    // leaked secret becomes a password login for every account in the table.
    assert.match(FN, /\.where\(eq\(users\.email, reviewEmail\)\)/,
        'the user lookup must use the env-configured address, not the request body');
    assert.ok(!/eq\(users\.email, email\)/.test(FN),
        'the caller-supplied email must never reach a user lookup');
});

check('both secrets are compared before anything is returned', () => {
    // Returning as soon as the address is wrong turns response time into an oracle for
    // "is this the review account?".
    assert.match(FN, /const emailOk = secretsMatch\(/);
    assert.match(FN, /const secretOk = secretsMatch\(/);
    assert.match(FN, /for \(const r of reviewers\) \{/, 'every live slot must be checked');
    assert.match(FN, /if \(emailOk && secretOk && !matched\) matched = r;/,
        'a slot matches only on its own address AND its own secret, with no early return');
    assert.match(FN, /if \(!matched\) \{/, 'then one combined rejection');
    assert.match(FN, /timingSafeEqual/, 'the comparison must be constant-time');
});

console.log('\n──── a separate Meta reviewer slot ────');

const META = REVIEW_SLOTS.find(s => s.key === 'meta')!;
const GOOGLE = REVIEW_SLOTS.find(s => s.key === 'google')!;

check('the Google slot keeps the original env names, so deploying this changes nothing for it', () => {
    assert.equal(GOOGLE.envPrefix, 'REVIEW_LOGIN', 'renaming would switch off a live Google reviewer on deploy');
    assert.deepEqual(resolveReviewConfig({ REVIEW_LOGIN_PASSWORD: STRONG }),
        resolveReviewConfig({ REVIEW_LOGIN_PASSWORD: STRONG }, GOOGLE),
        'the default slot must be Google, so existing callers are unaffected');
});

check('the Meta slot is dark unless its OWN password is set', () => {
    assert.equal(resolveReviewConfig({}, META).enabled, false);
    assert.equal(resolveReviewConfig({ REVIEW_LOGIN_PASSWORD: STRONG }, META).enabled, false,
        "Google's password must not switch on the Meta slot");
    const cfg = resolveReviewConfig({ META_REVIEW_LOGIN_PASSWORD: STRONG }, META);
    assert.equal(cfg.enabled === true && cfg.email, DEFAULT_META_REVIEW_EMAIL);
});

check('the Meta slot has its own weak-secret and fail-closed expiry rules', () => {
    assert.equal(resolveReviewConfig({ META_REVIEW_LOGIN_PASSWORD: 'short' }, META).enabled, false);
    const bad = resolveReviewConfig({ META_REVIEW_LOGIN_PASSWORD: STRONG, META_REVIEW_LOGIN_EXPIRES: 'soon' }, META);
    assert.equal(bad.enabled === false && bad.reason, 'bad_expiry');
    const past = resolveReviewConfig({ META_REVIEW_LOGIN_PASSWORD: STRONG, META_REVIEW_LOGIN_EXPIRES: '2020-01-01' }, META);
    assert.equal(past.enabled === false && past.reason, 'expired');
});

check('each slot switches on and off independently', () => {
    const both = resolveEnabledReviewers({ REVIEW_LOGIN_PASSWORD: STRONG, META_REVIEW_LOGIN_PASSWORD: 'y'.repeat(MIN_SECRET_LEN) });
    assert.deepEqual(both.map(r => r.slot), ['google', 'meta']);
    assert.deepEqual(resolveEnabledReviewers({ META_REVIEW_LOGIN_PASSWORD: STRONG }).map(r => r.slot), ['meta'],
        'Meta alone must work with Google switched off');
    assert.deepEqual(resolveEnabledReviewers({ REVIEW_LOGIN_PASSWORD: STRONG, META_REVIEW_LOGIN_EXPIRES: '2020-01-01', META_REVIEW_LOGIN_PASSWORD: STRONG }).map(r => r.slot), ['google'],
        "an expired Meta slot must not take Google's down with it");
    assert.deepEqual(resolveEnabledReviewers({}), [], 'no passwords means the endpoint is dark');
});

check('the two slots never share an address by default', () => {
    assert.notEqual(DEFAULT_META_REVIEW_EMAIL, DEFAULT_REVIEW_EMAIL);
});

console.log('\n──── it does not disturb the login real users have ────');

check('the customer magic-link page gained no password field', () => {
    assert.ok(!/type="password"/.test(LOGIN),
        'login.html must stay magic-link only — the review password lives on its own page');
    assert.match(LOGIN, /functions\/login/, 'and must still post to the magic-link endpoint');
});

check('the reviewer page talks only to the reviewer endpoint', () => {
    assert.match(PAGE, /functions\/review-login/, 'the review page must post to review-login');
    assert.ok(!/functions\/login\b/.test(PAGE), 'and must not also drive the magic-link endpoint');
    assert.match(PAGE, /name="robots" content="noindex/, 'the review page must not be indexable');
    assert.ok(!PAGE.includes(DEFAULT_REVIEW_EMAIL) && !PAGE.includes(DEFAULT_META_REVIEW_EMAIL),
        'the page must not print a reviewer address, e.g. as a placeholder');
    assert.ok(!/Gmail/.test(PAGE), 'the page serves every platform review, not just Google');
});

check('the session it mints is the one the rest of the app reads', () => {
    // ⚠️ auth-check.js and admin.html read aura_session from document.cookie, so an HttpOnly
    // cookie here would produce a session that fails only on this path. The cookie string is
    // asserted identical to verify.ts's rather than merely "present".
    const cookie = /aura_session=\$\{signedToken\}; Path=\/; Secure; SameSite=Lax; Max-Age=\$\{7 \* 24 \* 60 \* 60\}/;
    assert.match(VERIFY, cookie, 'premise: this is verify.ts\'s cookie');
    assert.match(FN, cookie, 'review-login must mint a byte-identical session cookie');
    // ⚠️ Matched on the COOKIE LINE, not the file. The comment above it necessarily explains why
    // HttpOnly is absent, so a whole-file search fails on the fix's own documentation.
    const cookieLine = FN.split('\n').find(l => l.includes('const sessionCookie =')) ?? '';
    assert.ok(cookieLine.length > 0, 'could not find the cookie construction to check');
    assert.ok(!/HttpOnly/i.test(cookieLine), 'adding HttpOnly here would break client-side session reads');
    assert.match(FN, /tokenPayload\.activeOrganisationId = activeOrg\.organisationId/,
        'without the org claim the workspace loads with no tenant at all');
});

check('failures are rate limited and logged', () => {
    assert.match(FN, /checkRateLimit\(db, 'review-login'/, 'attempts must be rate limited');
    assert.match(FN, /console\.warn\(`\[review-login\] Failed attempt/, 'failures must be visible in logs');
    assert.match(FN, /console\.warn\(`\[review-login\] Review session issued/, 'so must successes');
});

check('a disabled endpoint is indistinguishable from a missing one', () => {
    assert.match(FN, /statusCode: 404/, 'a disabled endpoint must 404, not 401 or 403');
    assert.ok(!/reason/.test(FN.slice(FN.indexOf('const NOT_FOUND'), FN.indexOf('const NOT_FOUND') + 220)),
        'the 404 body must not name the reason it is off');
});

console.log(`\n${passed} checks passed.`);
