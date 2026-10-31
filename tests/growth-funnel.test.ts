// tests/growth-funnel.test.ts — the growth funnel (owner, 2026-10-31): our own cookieless visit
// counter, the sign-up's source, and Admin → Analytics → Growth funnel.
//
// What can break without anything else failing:
//   · the counter starts storing something on the device, or the endpoint keeps an IP / user agent
//     (the privacy policy promises neither);
//   · a referrer or tag lands in the wrong source, or an unknown sign-up is relabelled "direct";
//   · the endpoint answers 204 '' (a 502 under withLambda) and the page loses its source;
//   · a marketing page drops the script, or register stops sending / saving the source.
//
// Run:  npx tsx tests/growth-funnel.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyVisit, cleanPath, cleanSignupSource, isBot, labelForHost, referrerHost, DIRECT } from '../src/utils/visit-source';
import { buildFunnel, cleanDay, funnelRange, UNKNOWN_SOURCE } from '../src/utils/growth-funnel';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const code = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

console.log('\n──── where a visit came from ────');

check('known sites get their name; specific hosts win over the general ones', () => {
    assert.strictEqual(labelForHost('gemini.google.com'), 'gemini');
    assert.strictEqual(labelForHost('google.co.uk'), 'google');
    assert.strictEqual(labelForHost('chatgpt.com'), 'chatgpt');
    assert.strictEqual(labelForHost('lnkd.in'), 'linkedin');
    assert.strictEqual(labelForHost('l.facebook.com'), 'facebook');
    assert.strictEqual(labelForHost('t.co'), 'x');
    assert.strictEqual(labelForHost('uk.trustpilot.com'), 'trustpilot');
    assert.strictEqual(labelForHost('somebusinessblog.co.uk'), 'somebusinessblog.co.uk');
    assert.strictEqual(referrerHost('https://www.LinkedIn.com/feed/?x=1'), 'linkedin.com');
    assert.strictEqual(referrerHost(''), null);
});

check('a campaign tag beats the referrer, and starts a visit', () => {
    assert.deepStrictEqual(classifyVisit({ path: '/pricing', ref: 'www.google.com', utmSource: 'LinkedIn Ads', utmCampaign: 'Oct launch' }),
        { path: '/pricing', source: 'linkedin-ads', campaign: 'oct-launch', entry: true });
});

check('another site starts a visit; our own site and a carried ?src= do not', () => {
    assert.deepStrictEqual(classifyVisit({ path: '/', ref: 'chatgpt.com' }), { path: '/', source: 'chatgpt', campaign: '', entry: true });
    assert.deepStrictEqual(classifyVisit({ path: '/register', ref: 'bemoreswan.com', src: 'chatgpt' }), { path: '/register', source: 'chatgpt', campaign: '', entry: false });
    assert.deepStrictEqual(classifyVisit({ path: '/faq', ref: 'bemoreswan.com' }), { path: '/faq', source: DIRECT, campaign: '', entry: false });
    assert.deepStrictEqual(classifyVisit({ path: '/', ref: '' }), { path: '/', source: DIRECT, campaign: '', entry: true });
});

check('pages are counted by their clean address; anything else is refused', () => {
    assert.strictEqual(cleanPath('/index.html'), '/');
    assert.strictEqual(cleanPath('/pricing.html?x=1#top'), '/pricing');
    assert.strictEqual(cleanPath('/ai-mystery-shopper/'), '/ai-mystery-shopper');
    assert.strictEqual(cleanPath('https://evil.example/'), null);
    assert.strictEqual(cleanPath('/<script>'), null);
    assert.strictEqual(cleanPath('/' + 'a'.repeat(200)), null);
    assert.strictEqual(classifyVisit({ path: 'nope' }), null);
});

check('crawlers are skipped; an empty user agent counts as one', () => {
    assert.ok(isBot('Googlebot/2.1') && isBot('facebookexternalhit/1.1') && isBot('curl/8.0') && isBot(''));
    assert.ok(!isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'));
});

check('a sign-up source is a safe label or nothing', () => {
    assert.deepStrictEqual(cleanSignupSource({ source: 'LinkedIn', campaign: 'Oct' }), { source: 'linkedin', campaign: 'oct' });
    assert.strictEqual(cleanSignupSource({ source: '' }), null);
    assert.strictEqual(cleanSignupSource('linkedin'), null);
    assert.strictEqual(cleanSignupSource(undefined), null);
});

console.log('\n──── the funnel ────');

check('stages total the sources, with each stage as a share of the one before', () => {
    const f = buildFunnel(
        [{ source: 'linkedin', entries: 40, views: 90 }, { source: 'google', entries: 60, views: 100 }],
        [
            { source: 'linkedin', confirmed: true, hired: true, approved: true, paid: true },
            { source: 'linkedin', confirmed: true, hired: true, approved: false, paid: false },
            { source: null, confirmed: false, hired: false, approved: false, paid: false },
            { source: 'google', confirmed: true, hired: false, approved: false, paid: false },
        ]);
    assert.deepStrictEqual(f.stages.map((s) => s.count), [100, 4, 3, 2, 1, 1]);
    assert.strictEqual(f.stages[0].fromPrevious, null);
    assert.strictEqual(f.stages[1].fromPrevious, 4);
    assert.strictEqual(f.stages[2].fromPrevious, 75);
    assert.strictEqual(f.views, 190);
    assert.strictEqual(f.bySource[0].source, 'linkedin', 'paying sources first');
    assert.ok(f.bySource.some((r) => r.source === UNKNOWN_SOURCE && r.signups === 1), 'no source is "unknown"');
    assert.ok(!f.bySource.some((r) => r.source === 'direct'), 'unknown is never folded into direct');
});

check('a stage after zero has no percentage rather than a fake one', () => {
    const f = buildFunnel([], [{ source: 'x', confirmed: false, hired: false, approved: false, paid: false }]);
    assert.strictEqual(f.stages[1].fromPrevious, null, 'sign-ups ÷ 0 visits');
    assert.strictEqual(f.stages[4].fromPrevious, null, 'approved ÷ 0 hired');
});

check('the range: what was asked, swapped if backwards, else the last 30 days', () => {
    assert.deepStrictEqual(funnelRange('', '', '2026-10-31'), { from: '2026-10-02', to: '2026-10-31' });
    assert.deepStrictEqual(funnelRange('2026-10-20', '2026-10-01', '2026-10-31'), { from: '2026-10-01', to: '2026-10-20' });
    assert.strictEqual(cleanDay('2026-02-30'), null);
    assert.strictEqual(cleanDay("2026-10-01'; DROP"), null);
});

console.log('\n──── the privacy promises hold ────');

check('the counter stores nothing on the device and never sends credentials', () => {
    const js = code(read('visit-count.js'));
    for (const banned of ['document.cookie', 'localStorage', 'sessionStorage', 'indexedDB']) assert.ok(!js.includes(banned), banned);
    assert.match(js, /credentials: 'omit'/);
    assert.match(js, /window\.VisitSource = \{ ready: ready \}/);
});

check('the endpoint keeps no IP or user agent, and always answers 200 with a body', () => {
    const fn = code(read('netlify/functions/track-visit.ts'));
    assert.ok(!/client-connection-ip|x-forwarded-for|getClientIp|checkRateLimit/.test(fn), 'reads or stores the IP');
    assert.ok(!/userAgent\s*:|user_agent\s*:/.test(fn), 'stores the user agent');
    assert.ok(!/json\(204|statusCode:\s*204/.test(fn), '204 + empty body is a 502 under withLambda');
    const sql = read('db/z-growth-funnel.sql');
    assert.ok(!/\bip\b|user_agent|visitor_id/i.test(sql.replace(/--.*$/gm, '')), 'a column that identifies a visitor');
});

check('every marketing page and the sign-up page load the counter', () => {
    const pages = ['index', 'pricing', 'how-it-works', 'assistants', 'assistant', 'about', 'blog', 'faq', 'contact', 'connections',
        'be-more-swan-vs-marketing-agency', 'website-builder-for-small-business', 'register'];
    for (const p of pages) assert.ok(read(`${p}.html`).includes('<script src="/visit-count.js" defer></script>'), `${p}.html`);
    for (const p of ['admin', 'workspace', 'dashboard']) assert.ok(!read(`${p}.html`).includes('src="/visit-count.js"'), `${p}.html is not marketing`);
});

check('register sends the source with both sign-up calls, and register.ts saves it without blocking', () => {
    const html = read('register.html');
    assert.strictEqual((html.match(/signupSource: await currentSignupSource\(\)/g) || []).length, 2);
    assert.match(html, /setTimeout\(\(\) => r\(null\), 1500\)/);
    const fn = read('netlify/functions/register.ts');
    assert.match(fn, /cleanSignupSource\(body\.signupSource\)/);
    assert.match(fn, /insert\(signupSources\)[\s\S]{0,120}onConflictDoNothing\(\)/);
});

check('the funnel is admin-only, never counts the Mentor as a hire, and only real money as paid', () => {
    const fn = read('netlify/functions/admin-funnel.ts');
    assert.match(fn, /isAdminRole\(row\?\.role\)/);
    assert.match(fn, /<> 'business_mentor'/);
    assert.match(fn, /p\.status = 'completed' AND p\.amount > 0/);
    assert.match(fn, /u\.role = 'user'/);
    assert.match(read('admin.html'), /loadGrowthFunnel\(from, to\);/);
});

check('the privacy policy describes the counter, and no page still promises no tracking scripts', () => {
    const p = read('privacy.html');
    assert.match(p, /Counting visits to our public pages/);
    assert.match(p, /does not keep your IP address or a visitor ID/);
    assert.ok(!/There is no advertising or analytics tracking on this site/.test(p));
    assert.ok(!/no tracking scripts/i.test(read('partners.html')));
});

console.log(`\n${passed} checks passed.`);
