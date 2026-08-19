// tests/audience-capture.test.ts
// The embeddable sign-up form and the double opt-in behind it.
//
// This is the only path in the product where an anonymous browser on SOMEONE ELSE'S website can
// write into a tenant's data, and every failure here is quiet:
//
//   1. A GET that confirms. Mail scanners, corporate link rewriters and antivirus proxies fetch
//      every URL in an email. If the confirmation link completed on GET, a proportion of
//      subscriptions would confirm themselves — double opt-in that opts people in.
//   2. An empty allowlist read as "any". `null` (never configured) and `[]` (configured, then
//      cleared) are different states. Collapsing them turns "I locked this down" into the opposite,
//      and the form keeps working, so nobody finds out.
//   3. A resurrected opt-out. Anyone can type anyone's address into a public form. If that raised a
//      contact out of unsubscribed/bounced/complained, the form would be a tool for re-subscribing
//      people who asked to be left alone.
//   4. A bot that can tell it was caught. The honeypot and the timing check only work while they
//      are indistinguishable from success.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    FORM_KEY_RE, MIN_FILL_MS, normaliseOrigin, originAllowed, sanitiseFields,
    validateFormTheme, validateRedirectUrl,
} from '../src/utils/audience-forms';
import {
    buildConfirmationEmail, confirmUrl, hashConfirmToken, mintConfirmToken, CONFIRM_TTL_DAYS,
} from '../src/utils/audience-email';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const PUBLIC = read('netlify/functions/audience-public.ts');
const WIDGET = read('subscribe.js');
const FORMS = read('netlify/functions/audience-forms.ts');

async function main() {

// ── 1. null vs empty allowlist ───────────────────────────────────────────────

await check('a form that was never locked down accepts any website', () => {
    assert.equal(originAllowed(null, 'https://acme.com'), true);
    assert.equal(originAllowed(undefined, 'https://acme.com'), true);
    // No Origin header at all (a server-to-server post, an old browser) is still fine on an open
    // form — the form is open.
    assert.equal(originAllowed(null, null), true);
});

await check('an allowlist that was configured and then EMPTIED blocks everything', () => {
    // The whole reason this is a test: [] and null are one keystroke apart in a UI and opposite in
    // meaning. Reading [] as "any" silently re-opens a form the tenant just closed.
    assert.equal(originAllowed([], 'https://acme.com'), false);
    assert.equal(originAllowed([], null), false);
});

await check('a locked-down form matches on ORIGIN, ignoring path, case and trailing slash', () => {
    const allowed = ['https://Acme.com/newsletter', 'https://blog.acme.com'];
    assert.equal(originAllowed(allowed, 'https://acme.com'), true);
    assert.equal(originAllowed(allowed, 'https://ACME.com/'), true);
    assert.equal(originAllowed(allowed, 'https://blog.acme.com'), true);
    // A different host, a different scheme and a different port are all different origins.
    assert.equal(originAllowed(allowed, 'https://evil.com'), false);
    assert.equal(originAllowed(allowed, 'http://acme.com'), false);
    assert.equal(originAllowed(allowed, 'https://acme.com:8443'), false);
});

await check('a locked-down form refuses a request with no stated origin', () => {
    // A sandboxed iframe posts the literal string "null"; a scripted client sends nothing at all.
    // Neither can be matched against a list, and "cannot match" must not mean "allow".
    assert.equal(originAllowed(['https://acme.com'], null), false);
    assert.equal(originAllowed(['https://acme.com'], 'null'), false);
    assert.equal(originAllowed(['https://acme.com'], ''), false);
});

await check('normaliseOrigin refuses anything that is not http(s)', () => {
    assert.equal(normaliseOrigin('javascript:alert(1)'), null);
    assert.equal(normaliseOrigin('data:text/html,x'), null);
    assert.equal(normaliseOrigin('file:///etc/passwd'), null);
    // A bare hostname is what a tenant actually types, and it should work.
    assert.equal(normaliseOrigin('acme.com'), 'https://acme.com');
});

// ── 2. Values that end up on the customer's own page ─────────────────────────

await check('a theme accent that would break out of the CSS rule is rejected', () => {
    // The accent is interpolated into a <style> on the CUSTOMER'S website. Authenticated is not the
    // same as safe to interpolate — same rule as save-widget-config.ts.
    for (const bad of ['red; } body { display:none } .x {', 'url(javascript:alert(1))', '#12345', 'expression(x)']) {
        const res = validateFormTheme({ accent: bad });
        assert.ok('error' in res, `accent ${JSON.stringify(bad)} must be rejected`);
    }
    const ok = validateFormTheme({ accent: '#B45309', layout: 'inline' });
    assert.deepEqual(ok, { theme: { accent: '#b45309', layout: 'inline' } });
});

await check('a redirect must be a real http(s) URL', () => {
    assert.equal(validateRedirectUrl('javascript:alert(1)'), null);
    assert.equal(validateRedirectUrl('/thanks'), null);
    assert.ok(validateRedirectUrl('https://acme.com/thanks')?.startsWith('https://acme.com/thanks'));
});

await check('the widget only ever navigates to a URL the SERVER handed back', () => {
    // An open redirect in a snippet that runs on hundreds of customer sites is worth one assertion.
    const redirect = WIDGET.slice(landmark(WIDGET, 'out.data.redirectUrl'));
    assert.match(redirect.slice(0, 200), /location\.href = out\.data\.redirectUrl/);
    assert.ok(!/location\.href = (?!out\.data\.redirectUrl)/.test(WIDGET),
        'no other assignment to location.href — the redirect target must come from the server');
});

await check('a form always collects an email, whatever the client asked for', () => {
    assert.deepEqual(sanitiseFields([]), ['email']);
    assert.deepEqual(sanitiseFields(['first_name']), ['email', 'first_name']);
    assert.deepEqual(sanitiseFields(['email', 'password', 'ssn']), ['email']);
});

await check('the form key has its own namespace, distinct from the blog widget key', () => {
    // wgt_ is a READ key for cacheable content; aud_ authorises anonymous WRITES. One table, one
    // meaning — a shared format is how the two get confused later.
    assert.ok(FORM_KEY_RE.test('aud_' + 'a'.repeat(24)));
    assert.ok(!FORM_KEY_RE.test('wgt_' + 'a'.repeat(24)));
    assert.ok(!FORM_KEY_RE.test('aud_short'));
    assert.match(FORMS, /'aud_' \+ randomBytes\(12\)\.toString\('hex'\)/);
});

// ── 3. The confirmation link ─────────────────────────────────────────────────

await check('GET on the confirmation route renders a page and changes nothing', () => {
    // The failure this prevents: a link scanner confirming subscriptions on people's behalf.
    const confirmBlock = PUBLIC.slice(landmark(PUBLIC, "if (path.includes('/api/audience/confirm'))"));
    const getBranch = confirmBlock.slice(
        landmark(confirmBlock, "if (method === 'GET')"),
        landmark(confirmBlock, "if (method !== 'POST')"),
    );
    assert.ok(getBranch.includes('return page('), 'GET must render a page');
    assert.ok(!getBranch.includes('setContactStatus'), 'GET must not write the subscription');
    assert.ok(getBranch.includes('method="POST"'), 'and the page must offer a POST form to do it');
});

await check('HEAD is answered before anything touches the database', () => {
    // Scanners send HEAD. It must be free and it must be inert.
    const headAt = landmark(PUBLIC, "if (method === 'HEAD')");
    const dbAt = landmark(PUBLIC, 'const db = getDb();');
    assert.ok(headAt < dbAt, 'the HEAD short-circuit must come before getDb()');
});

await check('the stored credential is a HASH, never the token', () => {
    const token = mintConfirmToken();
    assert.ok(token.length >= 24, 'a guessable token is the whole vulnerability');
    const hash = hashConfirmToken(token);
    assert.notEqual(hash, token);
    assert.equal(hash, hashConfirmToken(token), 'hashing must be stable or no link would ever verify');
    assert.match(hash, /^[0-9a-f]{64}$/);
    // And the endpoint must look rows up BY the hash, not by the raw token.
    assert.match(PUBLIC, /audienceConfirmations\.tokenHash, hashConfirmToken\(token\)/);
});

await check('the confirmation email says who it is from, when it expires, and how to ignore it', () => {
    const mail = buildConfirmationEmail({
        to: 'jane@acme.com', firstName: 'Jane', senderName: 'Acme Ltd',
        sourceUrl: 'https://acme.com/pricing', baseUrl: 'https://bemoreswan.com', token: 'tok_123456789012345678',
    });
    assert.ok(mail.subject.includes('Acme Ltd'), 'the subject must name whose list this is');
    assert.ok(mail.html.includes(confirmUrl('https://bemoreswan.com', 'tok_123456789012345678')));
    assert.ok(mail.text.includes(confirmUrl('https://bemoreswan.com', 'tok_123456789012345678')),
        'the plain-text part needs the link too — a text-only client must still be able to confirm');
    assert.ok(mail.html.includes(String(CONFIRM_TTL_DAYS)), 'say how long the link lasts');
    assert.match(mail.text, /did not sign up/, 'tell someone who did not sign up that ignoring it is enough');
});

await check('a nameless subscriber is greeted, not left with "Hi ,"', () => {
    const mail = buildConfirmationEmail({
        to: 'x@y.com', firstName: '', senderName: 'Acme Ltd', baseUrl: 'https://bemoreswan.com', token: 'tok_123456789012345678',
    });
    assert.ok(mail.html.includes('there'), 'a blank merge var is the classic tell of a broken mailing');
    assert.ok(!/,\s*<\/h1>/.test(mail.html));
});

await check('the From line names the tenant while the address stays on our verified domain', () => {
    const email = read('src/utils/audience-email.ts');
    const send = email.slice(landmark(email, 'export async function sendConfirmationEmail'));
    assert.match(send, /via Be More Swan/, 'the recipient has never heard of us — say how we relate to the sender');
    assert.match(send, /noreply@bemoreswan\.com/, 'the ADDRESS must stay on the domain Resend has verified');
    assert.match(send, /replace\(\/\["<>\\r\\n\]\/g/, 'a crafted organisation name must not restructure the header');
});

// ── 4. The controls that only work while they are silent ─────────────────────

await check('the honeypot and the timing check answer with the ordinary success body', () => {
    const sub = PUBLIC.slice(landmark(PUBLIC, 'const successBody = {'));
    const hp = sub.slice(landmark(sub, 'if (String(body.hp'), landmark(sub, 'const ip = getClientIp'));
    assert.ok(!hp.includes('json(400'), 'a bot that learns it was caught comes back without the tell');
    assert.equal((hp.match(/return json\(200, successBody, origin\)/g) || []).length, 2,
        'both the honeypot and the timing check must return the SAME body as a real sign-up');
    assert.ok(sub.includes('MIN_FILL_MS'), 'the timing floor must be the shared constant');
    assert.ok(MIN_FILL_MS >= 1000, 'below a second this would start rejecting fast humans');
});

await check('the widget actually sends what those checks read', () => {
    assert.match(WIDGET, /name="website"/, 'the honeypot field must exist in the rendered form');
    assert.match(WIDGET, /ms: Date\.now\(\) - shownAt/, 'and the elapsed time must be measured from RENDER');
    assert.match(WIDGET, /shownAt = Date\.now\(\)/);
    // Off-screen, not display:none — some bots skip hidden fields and fill everything else.
    assert.match(WIDGET, /\.bms-hp\{position:absolute!important;left:-9999px/);
});

await check('a terminal contact state is never resurrected by a public form post', () => {
    const sub = PUBLIC.slice(landmark(PUBLIC, 'const [existing] = await db'));
    const terminal = sub.slice(landmark(sub, "existing.status === 'bounced'"), landmark(sub, 'let contactId'));
    assert.ok(terminal.includes('return json(200, successBody, origin)'),
        'a bounced/complained/suppressed address gets the ordinary success body and no write');
    assert.ok(!terminal.includes('upsertContact'), 'and nothing is written for it');
});

await check('an unsubscribed address can only return through the confirmation email', () => {
    const sub = PUBLIC.slice(landmark(PUBLIC, 'const returning ='));
    const branch = sub.slice(0, landmark(sub, 'let contactId'));
    assert.ok(branch.includes('!form.doubleOptIn'),
        'without double opt-in there is nothing proving the person asked, so the opt-out stands');
    // The contact row must NOT be flipped here — only POST /confirm may do that.
    const after = sub.slice(landmark(sub, 'if (returning) {'), landmark(sub, 'await recordConsentEvent'));
    assert.ok(!after.includes("status: 'subscribed'"),
        'the sign-up path must never set subscribed for a returning opt-out — only the confirm click may');
});

await check('the consent event is written before anything is sent', () => {
    // The evidence is the lawful basis. A subscription we cannot account for is one we should not
    // have taken, so the event lands before the confirmation email goes out.
    const sub = PUBLIC.slice(landmark(PUBLIC, 'const [existing] = await db'));
    assert.ok(landmark(sub, 'await recordConsentEvent') < landmark(sub, 'await sendConfirmationEmail'));
});

await check('a rate-limiter outage does not take the customer\'s form down with it', () => {
    const limiter = PUBLIC.slice(landmark(PUBLIC, "checkRateLimit(db, 'audience_subscribe'"), landmark(PUBLIC, 'const email = normaliseEmail'));
    assert.match(limiter, /catch/, 'the limiter must be wrapped');
    assert.ok(!/catch[\s\S]{0,200}return json\(5/.test(limiter),
        'a limiter failure must not 500 the sign-up — origin, honeypot, timing and double opt-in still stand');
});

// ── 5. Public responses leak nothing about who is on the list ────────────────

await check('the SIGN-UP response never reports whether an address is already known', () => {
    // Scoped to the sign-up half deliberately. The confirmation page DOES say "you are already
    // subscribed", and that is fine: reaching it requires the token from the email, so the only
    // person being told is the one who owns the inbox. The public form is the surface where
    // anyone holding the snippet could probe a tenant's list, so it says the same thing to
    // everyone.
    const signup = PUBLIC.slice(landmark(PUBLIC, "if (!path.includes('/api/audience/subscribe'))")).toLowerCase();
    for (const phrase of ['already subscribed', 'already on your list', 'not in your audience', 'unsubscribed earlier']) {
        assert.ok(!signup.includes(phrase),
            `"${phrase}" would tell anyone holding the snippet who is on a tenant's list`);
    }
    // Every non-input outcome resolves to the one shared body.
    assert.ok(signup.includes('successbody'));
});

await check('the one explicit error is the tenant\'s own misconfiguration', () => {
    const originErr = PUBLIC.slice(landmark(PUBLIC, "code: 'origin_not_allowed'") - 400, landmark(PUBLIC, "code: 'origin_not_allowed'") + 60);
    assert.match(originErr, /not on the allowed list/);
    // And the widget translates it for the visitor, who cannot act on it.
    assert.match(WIDGET, /origin_not_allowed/);
    assert.match(WIDGET, /not set up for this website yet/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
