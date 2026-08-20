// tests/audience-hosted-page.test.ts
// A sign-up page we host, for the customers who have no website to embed a form in.
//
// It is a public URL on OUR domain, carrying a tenant's name, collecting real addresses from
// strangers. Five ways that goes wrong:
//
//   1. ⚠️ IT BECOMES A HOLE IN A LOCKED-DOWN FORM. allowed_origins exists so a tenant can say "only
//      my site may post to this". Serving a page anyone can open, from an origin that bypasses that
//      check, would undo it for every form rather than for the ones that asked.
//   2. IT EXISTS WITHOUT ANYONE ASKING FOR IT. Every form would have a public page the moment this
//      shipped, including forms built for a locked-down intranet.
//   3. IT LEAKS WHICH TENANTS HAVE ONE. A distinguishable 404 turns a url into an oracle.
//   4. IT DROPS THE ANTI-BOT PAIR THE EMBED HAS. A page on our own domain is a MORE attractive
//      target than one small business's website, not a less attractive one.
//   5. IT SAYS SOMETHING DIFFERENT ABOUT CONSENT than the form it belongs to.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { hostedMissing, hostedPage } from '../netlify/functions/audience-public';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
}

const PUBLIC = read('netlify/functions/audience-public.ts');
const FORMS = read('netlify/functions/audience-forms.ts');
const SQL = read('db/audience-hosted-pages.sql');
const TOML = read('netlify.toml');
const UI = read('audience.js');

console.log('\nThe hosted sign-up page\n');

// ── 1. It does not weaken the origin lock ───────────────────────────────────

check('our own origin is allowed ONLY for a form that switched the page on', () => {
    // ⚠️ Relaxing the check for our origin unconditionally would mean any form — including one
    // deliberately locked to an intranet — could be posted to from a page anyone can open.
    const fn = PUBLIC.slice(landmark(PUBLIC, 'const fromHostedPage'), landmark(PUBLIC, 'const successBody'));
    assert.match(fn, /form\.hostedEnabled && !!origin && origin === resolveBaseUrl/);
    assert.match(fn, /if \(!fromHostedPage && !originAllowed\(/);
});

check('the allowance is tied to the request origin, not to the mere existence of the page', () => {
    const fn = PUBLIC.slice(landmark(PUBLIC, 'const fromHostedPage'), landmark(PUBLIC, 'const successBody'));
    assert.ok(!/hostedEnabled\s*\)\s*;?\s*$/m.test(fn.split('\n')[0]), 'the flag alone must not be the condition');
    assert.match(fn, /origin === resolveBaseUrl/);
});

// ── 2. Nobody gets one by accident ──────────────────────────────────────────

check('the page is off by default, in the schema', () => {
    assert.match(SQL, /hosted_enabled\s+BOOLEAN NOT NULL DEFAULT false/);
    assert.match(SQL, /OFF BY DEFAULT/);
});

check('switching it on is an explicit field, not inferred from a headline', () => {
    const fn = FORMS.slice(landmark(FORMS, "if (action === 'update')"), landmark(FORMS, "if ('redirectUrl' in body)"));
    assert.match(fn, /hostedEnabled = body\.hostedEnabled === true/);
});

check('a switched-off page answers exactly like a key that never existed', () => {
    // ⚠️ Otherwise the url is an oracle for which tenants have a sign-up page.
    const fn = PUBLIC.slice(landmark(PUBLIC, 'const hostedMatch'), landmark(PUBLIC, '// ── Confirmation'));
    assert.match(fn, /!form \|\| form\.status !== 'active' \|\| !form\.hostedEnabled\) return hostedMissing\(\)/);
    assert.match(fn, /not something a stranger with a url should learn/);
    // One function for both, so they cannot drift apart.
    assert.strictEqual((PUBLIC.match(/return hostedMissing\(\)/g) || []).length, 2);
});

// ── 3. It is the same form, reached another way ─────────────────────────────

check('the page reads the form\'s own consent text and opt-in setting', () => {
    const fn = PUBLIC.slice(landmark(PUBLIC, 'const hostedMatch'), landmark(PUBLIC, '// ── Confirmation'));
    assert.match(fn, /consentText: form\.consentText \|\| DEFAULT_CONSENT_TEXT/);
    assert.match(fn, /doubleOptIn: form\.doubleOptIn/);
    // The reasoning sits in the comment ABOVE the branch, so it is asserted against the file.
    assert.match(PUBLIC, /a second description of what somebody agreed to/);
});

check('it posts to the SAME endpoint as the embeddable widget', () => {
    // Two callers of one contract, rather than two contracts.
    assert.match(PUBLIC, /fetch\('\/api\/audience\/subscribe'/);
    assert.match(PUBLIC, /two callers of[\s\S]{0,20}one endpoint/);
});

check('it is served by a rewrite so the shareable url survives', () => {
    const block = TOML.slice(landmark(TOML, 'from = "/s/*"'));
    assert.match(block.slice(0, 200), /status = 200/);
    assert.match(block.slice(0, 200), /audience-public/, 'and by the function that owns what a form says');
    assert.match(TOML, /url is the whole product here/);   // stated above the rule
});

// ── 4. The protections the embed has ────────────────────────────────────────

check('the honeypot and the fill-time check are both on the page', () => {
    // ⚠️ A public url on our own domain is a MORE attractive target, not a less attractive one.
    const fn = PUBLIC.slice(landmark(PUBLIC, 'function hostedPage'), landmark(PUBLIC, 'function corsHeaders'));
    assert.match(fn, /name="hp"/, 'the honeypot field');
    assert.match(fn, /ms: Date\.now\(\) - started/, 'the fill-time the server checks against MIN_FILL_MS');
    assert.match(PUBLIC, /SAME anti-bot pair/);
});

check('the page is noindex, and says why', () => {
    const fn = PUBLIC.slice(landmark(PUBLIC, 'function hostedPage'), landmark(PUBLIC, 'function corsHeaders'));
    assert.match(fn, /noindex,nofollow/);
    assert.match(fn, /'X-Robots-Tag': 'noindex'/);
    assert.match(PUBLIC, /abandoned or half-configured page indexed under our domain/);
    // The 404 page too — a missing page must not be indexed either.
    assert.match(PUBLIC.slice(landmark(PUBLIC, 'function hostedMissing')), /noindex/);
});

check('the page loads nothing from anywhere else', () => {
    const fn = PUBLIC.slice(landmark(PUBLIC, 'function hostedPage'), landmark(PUBLIC, 'function corsHeaders'));
    assert.match(fn, /default-src 'none'/);
    assert.match(fn, /connect-src 'self'/);
    assert.ok(!/https?:\/\/(?!fonts)/.test(fn.replace(/https?:\/\/[^'"\s]*audience[^'"\s]*/g, '')), 'no third-party origin may appear');
});

check('the form key reaching the inline script is validated first', () => {
    const fn = PUBLIC.slice(landmark(PUBLIC, 'const hostedMatch'), landmark(PUBLIC, '// ── Confirmation'));
    assert.ok(landmark(fn, 'FORM_KEY_RE.test(key)') < landmark(fn, 'return hostedPage('));
    assert.match(PUBLIC, /JSON\.stringify\(key\)/, 'and it is embedded as JSON, not interpolated raw');
});

// ── 5. What the tenant sees ─────────────────────────────────────────────────

check('the link is built from the browser\'s own origin', () => {
    // A hardcoded domain is what breaks on a preview deploy.
    assert.match(UI, /return `\$\{location\.origin\}\/s\/\$\{form\.publicKey\}`/);
});

check('the panel says the page is the same form, not a second one', () => {
    assert.match(UI, /same consent wording and double opt-in setting/);
    assert.match(UI, /No website needed/);
});

check('a headline is only sent when the field is on screen', () => {
    // Sending undefined while the page is off would blank a headline written earlier.
    assert.match(UI, /\$\('aud-form-hosted-headline'\) \? \{ hostedHeadline/);
});

// ── 6. What the page actually renders ───────────────────────────────────────
// Source scans above; these run the renderer and read its output, which is the thing a stranger
// will see.

const rendered = hostedPage('aud_0123456789abcdef01234567', {
    orgName: 'Acme & Sons',
    headline: 'The <weekly> letter',
    intro: 'One email a month.\nNothing else.',
    fields: ['email', 'first_name'],
    consentText: 'We will email you about "offers".',
    doubleOptIn: true,
});

check('the page renders as a whole document with the right headers', () => {
    assert.strictEqual(rendered.statusCode, 200);
    assert.match(rendered.headers['Content-Type'], /text\/html/);
    assert.strictEqual(rendered.headers['X-Robots-Tag'], 'noindex');
    assert.match(rendered.body, /^<!DOCTYPE html>/);
    assert.match(rendered.body, /<\/html>$/);
});

check('every tenant-supplied string is escaped in the output', () => {
    // ⚠️ The org name, the headline, the intro and the consent text are all tenant-written and all
    // land in a page served from OUR domain. One unescaped angle bracket is stored XSS on it.
    assert.ok(rendered.body.includes('Acme &amp; Sons'));
    assert.ok(rendered.body.includes('The &lt;weekly&gt; letter'));
    assert.ok(rendered.body.includes('about &quot;offers&quot;'));
    assert.ok(!rendered.body.includes('<weekly>'), 'no raw tenant markup may survive');
});

check('the requested fields are rendered, and nothing else is', () => {
    assert.match(rendered.body, /name="email"/);
    assert.match(rendered.body, /name="first_name"/);
    assert.ok(!rendered.body.includes('name="last_name"'), 'a field the form does not ask for must not appear');
    assert.ok(!rendered.body.includes('name="company"'));
});

check('email is required and the honeypot is not', () => {
    const emailInput = rendered.body.slice(rendered.body.indexOf('name="email"') - 60, rendered.body.indexOf('name="email"') + 80);
    assert.match(emailInput, /required/);
    assert.match(rendered.body, /class="hp"[\s\S]{0,220}name="hp"/);
    assert.match(rendered.body, /tabindex="-1"/, 'and it is out of the tab order for anyone using a keyboard');
});

check('the key in the script is the validated one, as a JSON string', () => {
    assert.match(rendered.body, /key: "aud_0123456789abcdef01234567"/);
});

check('a missing page renders a page, not a stack trace', () => {
    const gone = hostedMissing();
    assert.strictEqual(gone.statusCode, 404);
    assert.match(gone.body, /^<!DOCTYPE html>/);
    assert.match(gone.body, /not available/);
    assert.match(gone.headers['X-Robots-Tag'], /noindex/);
});

console.log(`\n${passed} checks passed.`);
