// tests/partner-applications.test.ts
// Affiliate Partner Programme, step 4 — applying, the private account link, /invite/<code> and the
// "Invited by" field (docs/affiliate-partner-programme-plan.md §4.2, §4.6).
//
// WHY THIS EXISTS (2026-10-18). Owner decision: apply first, account on approval — so the one way an
// outsider gets an account while sign-ups are locked is the approval email's link. That link must
// open the lock for the applicant's own email ONLY, work once, and never be readable from the
// database. Also pins: invite pages keep root-relative paths (the /powered-by bug), no cookies, the
// public page never hard-codes a rate, and the code that is SENT at sign-up is the one on screen.
// The flow's SQL is proven on Postgres in tests/partner-applications-db.test.ts.
//
// Run:  npx tsx tests/partner-applications.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationAnswers, hashInviteToken, newInviteToken, validateApplication, INVITE_TTL_DAYS } from '../src/utils/partner-applications';
import { getTemplateDefault } from '../src/utils/email-templates-catalog';
import { generateReferralCode } from '../src/utils/referral-code';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('the application');
const good = { name: ' Jo Example ', email: ' Jo@Example.com ', channels: ['newsletter', 'clients', 'bogus', 'newsletter'], audience: '4,000 readers', links: '', message: '', consent: true, acceptTerms: true };

check('a good application is tidied: trimmed, lower-cased email, known channels once each', () => {
    const r = validateApplication(good);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.value, { name: 'Jo Example', email: 'jo@example.com', channels: ['newsletter', 'clients'], audience: '4,000 readers', links: '', message: '' });
});

check('missing name, bad email, no channel, or no consent is refused in words', () => {
    assert.match((validateApplication({ ...good, name: '' }) as any).error, /your name/);
    assert.match((validateApplication({ ...good, email: 'jo@' }) as any).error, /valid email/);
    assert.match((validateApplication({ ...good, channels: ['bogus'] }) as any).error, /how you would promote/);
    assert.match((validateApplication({ ...good, consent: 'yes' }) as any).error, /tick the box/);
    assert.match((validateApplication({ ...good, acceptTerms: false }) as any).error, /Partner Terms/);
});

check('answers are stored the way the admin screen and the chat read them', () => {
    const r = validateApplication(good) as any;
    assert.deepStrictEqual(applicationAnswers(r.value), { 'How they will promote': 'Email newsletter, My own clients (consultancy / agency)', Audience: '4,000 readers' });
});

console.log('the private account link');

check('a token is random and only its hash is kept; it lasts 14 days', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    const a = newInviteToken(now), b = newInviteToken(now);
    assert.notStrictEqual(a.token, b.token);
    assert.ok(a.token.length >= 40);
    assert.strictEqual(a.hash, hashInviteToken(a.token));
    assert.notStrictEqual(a.hash, a.token);
    assert.strictEqual(a.expiresAt.getTime() - now.getTime(), INVITE_TTL_DAYS * 86_400_000);
});

check('the edge lets ONLY ?beta=1 and ?partner= past the lock', () => {
    const guard = read('netlify/edge-functions/auth-guard.ts');
    assert.ok(guard.includes("if (cfg.registrationLocked && path === '/register' && url.searchParams.get('beta') !== '1' && !url.searchParams.get('partner')) {"));
});

check('register.ts: the link opens the lock for the applicant\'s own email only, and a bad link is refused', () => {
    const reg = read('netlify/functions/register.ts');
    const check = reg.indexOf("phase = 'partner-check';");
    const lock = reg.indexOf('if (!isBeta && !partnerInvite && await isRegistrationLocked()) {');
    assert.ok(check > 0 && lock > check, 'the partner check must run before the lock');
    assert.ok(reg.includes("if (partnerToken && !partnerInvite) {"), 'a bad/spent link must not fall through to an ordinary sign-up');
    assert.ok(reg.includes("if (partnerInvite && (partnerInvite.applicantEmail || '').toLowerCase() !== email) {"));
    assert.ok(reg.includes('await claimPartnerInvite(db, partnerInvite.id, resultUser.id)'), 'the new account is linked');
    assert.ok(reg.includes('await claimPartnerInvite(db, partnerInvite.id, existingUser.id)'), 'an existing account with that email is linked too');
});

check('the three partner emails exist and the account link goes to register.html?partner=', () => {
    for (const key of ['partner_application_received', 'partner_approved', 'partner_approved_create_account']) {
        assert.ok(getTemplateDefault(key)?.transactional, `${key} missing or not transactional`);
    }
    assert.ok(getTemplateDefault('partner_approved_create_account')!.bodyHtml.includes('{{link.action_url}}'));
    assert.ok(read('src/utils/partner-applications.ts').includes('`${baseUrl()}/register.html?partner=${encodeURIComponent(token)}`'));
});

check('approving (screen or chat card) sends the approval email; reinstating does not', () => {
    const api = read('netlify/functions/admin-partners.ts');
    assert.ok(api.includes("if (rule.to === 'approved' && before.status !== 'suspended') {"));
    assert.ok(api.includes("if (body.action === 'resend_invite') {"));
});

console.log('the public pages');
const invite = read('invite.html');
const partnersPage = read('partners.html');

check('invite.html keeps every path root-relative (it is served from /invite/<code>)', () => {
    const relative = [...invite.matchAll(/(?:href|src)=["'](?!\/|https?:|#|mailto:)([^"']+)["']/g)].map((m) => m[1]);
    assert.deepStrictEqual(relative, [], `relative paths: ${relative.join(', ')}`);
    assert.ok(!/loadComponent\([^)]*'\.\//.test(invite), 'components must load from /components/');
});

check('/invite/<code> is a one-segment 200 rewrite and stays out of the index', () => {
    const toml = read('netlify.toml');
    assert.match(toml, /from = "\/invite\/:code"\n\s+to {3}= "\/invite\.html"\n\s+status = 200/);
    assert.match(toml, /for = "\/invite\*"\n\s+\[headers\.values\]\n\s+X-Robots-Tag = "noindex, nofollow"/);
});

check('no cookies or storage on the invite page; the code rides the URL into sign-up', () => {
    assert.ok(!/document\.cookie|localStorage|sessionStorage/.test(invite));
    assert.ok(invite.includes("'/register.html?ref=' + encodeURIComponent(d.code)"));
});

check('partners.html never hard-codes a rate — it reads the live programme terms', () => {
    assert.ok(!/\d+\s?%/.test(partnersPage.replace(/<script[\s\S]*?<\/script>/g, '')), 'a percentage is written into the page');
    assert.ok(partnersPage.includes("fetch('/.netlify/functions/partner-programme-public')"));
    assert.ok(!partnersPage.includes('noindex'), 'the programme is public — keep the page indexable');
    assert.ok(partnersPage.includes('<link rel="canonical" href="https://bemoreswan.com/partners">'));
    const sitemap = read('sitemap.xml');
    assert.ok(sitemap.includes('<loc>https://bemoreswan.com/partners</loc>'));
    assert.ok(sitemap.includes('<loc>https://bemoreswan.com/partner-terms</loc>'));
    const footer = read('components/footer.html');
    assert.ok(footer.includes('href="/partners.html"') && footer.includes('href="/partner-terms.html"'), 'linked from the footer');
});

check('invite-lookup reveals only a first name and counts visits for approved partners only', () => {
    const lookup = read('netlify/functions/invite-lookup.ts');
    assert.ok(lookup.includes('return json(200, { valid: true, code: invite.code, firstName: owner.firstName || null, offer: REFERRAL_OFFER_DISPLAY });'));
    assert.ok(lookup.includes("eq(partners.status, 'approved')"));
    assert.ok(lookup.includes("checkRateLimit(db, 'invite_click'"));
});

check('the application form has a honeypot and a fill timer, and the API honours both', () => {
    assert.ok(partnersPage.includes('id="pa-website"') && partnersPage.includes('ms: Date.now() - PA_OPENED_AT'));
    const api = read('netlify/functions/partner-apply.ts');
    assert.ok(api.includes("if ((typeof body.hp === 'string' && body.hp.trim()) || !Number.isFinite(ms) || ms < APPLY_LIMITS.minFillMs) {"));
});

console.log('"Invited by" at sign-up');
const register = read('register.html');

check('what is sent is what is on screen — the visible field, never a hidden stored code', () => {
    const bodies = register.match(/referralRef: [^,}\n]+/g) || [];
    assert.ok(bodies.length >= 2);
    for (const b of bodies) assert.strictEqual(b, 'referralRef: currentReferralRef()', b);
    assert.ok(register.includes('id="invitedBy"'));
});

check("a partner's own account link hides the field and sends the token", () => {
    assert.ok(register.includes('partnerToken: PARTNER_TOKEN || undefined'));
    assert.ok(register.includes("if (PARTNER_TOKEN) return undefined;"));
});

check('referral codes avoid look-alike characters and are upper case (register upper-cases what is typed)', () => {
    for (let i = 0; i < 200; i++) assert.match(generateReferralCode(), /^[A-HJ-NP-Z2-9]{8}$/);
    assert.ok(read('netlify/functions/register.ts').includes("body.referralRef?.trim().toUpperCase() || null"));
});

console.log(`\n${passed} passed`);
