// tests/site-taster.test.ts
// The Mystery Shopper's free public taster (docs/mystery-shopper-plan.md step 5): the pure result
// builder and tokens (src/utils/site-taster.ts), the public endpoint's guarantees
// (netlify/functions/site-audit-public.ts), the result email, and the marketing page's wiring.
//
// Run:  npx tsx tests/site-taster.test.ts
//
// What matters: a stranger can make us fetch a page and call a model from here, so the limits, the
// cache, the daily cap and the kill switch must all sit BEFORE the model call; a result is readable
// only with its token; the visitor's email address is never stored; and nothing here charges a
// workspace or adds anyone to a mailing list.

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSitePage } from '../src/utils/site-extract';
import { rubricFor } from '../src/utils/site-score';
import {
    buildTasterResult, tasterEmailHash, tasterToken, tasterUrlHash, unreadableResult, verifyTasterToken,
} from '../src/utils/site-taster';
import { getTemplateDefault } from '../src/utils/email-templates-catalog';
import { mergeTemplateParts } from '../src/utils/email-template';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const fixture = (n: string) => read(`tests/fixtures/site-pages/${n}.html`);
const weak = extractSitePage(fixture('squarespace-weak'), 'https://northgate-consulting.example/');
const answers = (good: boolean) => rubricFor('clarity').map((q) => ({ id: q.id, yes: good ? q.goodAnswer : !q.goodAnswer, evidence: '' }));

console.log('\nTokens and hashes');

check('a token unlocks exactly its own run, and only with the secret', () => {
    const t = tasterToken(42, 'k')!;
    assert.strictEqual(t.length, 32);
    assert.ok(verifyTasterToken(42, t, 'k'));
    assert.ok(!verifyTasterToken(43, t, 'k'), 'another run');
    assert.ok(!verifyTasterToken(42, t, 'other-secret'), 'another secret');
    assert.ok(!verifyTasterToken(42, t.slice(0, 31) + 'x', 'k'));
    assert.ok(!verifyTasterToken(42, 123, 'k'));
    assert.strictEqual(tasterToken(42, null), null, 'no secret → no tokens');
});

check('the same page hashes the same however it was typed; a different page does not', () => {
    assert.strictEqual(tasterUrlHash('https://www.Acme.example/'), tasterUrlHash('https://acme.example'));
    assert.strictEqual(tasterUrlHash('https://acme.example/pricing/'), tasterUrlHash('http://acme.example/pricing'));
    assert.notStrictEqual(tasterUrlHash('https://acme.example/'), tasterUrlHash('https://acme.example/pricing'));
});

check('the email hash ignores case and does not contain the address', () => {
    const h = tasterEmailHash('Jo@Acme.example');
    assert.strictEqual(h, tasterEmailHash(' jo@acme.example '));
    assert.ok(!h.includes('acme') && /^[0-9a-f]{64}$/.test(h));
});

console.log('\nThe result');

check('a poor first impression: score, at most five failures, and a grounded fix that prefers the headline', () => {
    const r = buildTasterResult(weak, {
        answers: answers(false),
        fixes: [
            { location: 'Top button', problem: 'Passive.', currentText: 'Learn More', suggestedText: 'Book a free call' },
            { location: 'Headline', problem: 'Generic.', currentText: "Empowering Tomorrow's Digital Synergy Today", suggestedText: 'Operations consulting for 10–50 person firms' },
        ],
    })!;
    assert.ok(r.score !== null && r.score < 40, String(r.score));
    assert.ok(r.failures.length > 0 && r.failures.length <= 5);
    assert.strictEqual(r.worstFix?.location, 'Headline');
    assert.match(r.summary, /^First impression: \d+ out of 100\./);
    assert.strictEqual(r.unreadable, false);
});

check('a fix quoting text that is not on the page is never shown', () => {
    const r = buildTasterResult(weak, { answers: answers(true), fixes: [{ location: 'Headline', problem: 'x', currentText: 'Award-winning since 1990', suggestedText: 'y' }] })!;
    assert.strictEqual(r.worstFix, null);
});

check('no usable answers → no result (the run fails rather than showing a code-only score)', () => {
    assert.strictEqual(buildTasterResult(weak, { answers: [{ id: 'nope', yes: true }] }), null);
    assert.strictEqual(buildTasterResult(weak, null), null);
});

check('an unreadable page is a result in its own right, never a low score', () => {
    const spa = extractSitePage(fixture('spa-shell'), 'https://acme.example/');
    const r = buildTasterResult(spa, null)!;
    assert.deepStrictEqual(r, unreadableResult('https://acme.example/'));
    assert.strictEqual(r.score, null);
});

check('the public result carries no page dump', () => {
    const r = buildTasterResult(weak, { answers: answers(true), fixes: [] })!;
    assert.deepStrictEqual(Object.keys(r).sort(), ['failures', 'score', 'summary', 'unreadable', 'url', 'worstFix']);
});

console.log('\nThe endpoint');

const api = read('netlify/functions/site-audit-public.ts');
const at = (s: string) => { const i = api.indexOf(s); assert.ok(i > -1, `missing: ${s}`); return i; };

check('order: kill switch → honeypot → input → limits → cache → daily cap → insert → wake the worker', () => {
    const order = [
        'CONFIG_KEYS.GLOBAL_AI_DISABLED', "body.hp === 'string'", 'normaliseSiteUrl(body.url)',
        "checkRateLimit(db, 'site_taster_ip'", 'if (cached) {', 'dailyCap()', 'db.insert(siteAuditRuns)', 'triggerSiteAudit(run.id',
    ].map(at);
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
});

check('a bot gets the same reply shape as a person', () => {
    assert.match(api, /return json\(202, \{ runId: 0, token: '0' \}\);/);
    assert.match(api, /return json\(202, \{ runId: run\.id, token: tasterToken\(run\.id\) \}\);/);
});

check('the email address is never stored — only its hash; it goes to the worker once', () => {
    const insert = api.slice(at('db.insert(siteAuditRuns).values({'), at('db.insert(siteAuditRuns).values({') + 200);
    assert.ok(/emailHash/.test(insert) && !/\bemail\b[,:]/.test(insert.replace(/emailHash/g, '')), insert);
    assert.match(api, /triggerSiteAudit\(run\.id, \{ emailTo: email \}\)/);
    const worker = read('netlify/functions/run-site-audit-background.ts');
    assert.ok(!/insert|update/.test(worker.replace(/\/\/.*$/gm, '')), 'the worker writes nothing itself');
});

check('a result is only readable with its token, and only the result is returned', () => {
    assert.match(api, /verifyTasterToken\(runId, body\.token\)/);
    assert.match(api, /select\(\{ status: siteAuditRuns\.status, report: siteAuditRuns\.report, error: siteAuditRuns\.error \}\)/);
    assert.match(api, /eq\(siteAuditRuns\.kind, 'public_taster'\)/);
});

check('no Date is bound into raw SQL', () => {
    for (const m of api.matchAll(/sql`[^`]*`/g)) {
        assert.ok(!/\$\{(new Date|now|cacheFromIso|todayStart)\}/.test(m[0]) || /::timestamp/.test(m[0]), m[0]);
    }
    assert.match(api, /const cacheFromIso = new Date\(.*\)\.toISOString\(\);/);
});

check('a taster never charges a workspace or touches a task allowance', () => {
    const pipeline = read('src/utils/site-audit.ts');
    const taster = pipeline.slice(pipeline.indexOf('async function executeTasterRun'));
    assert.ok(!/recordCompletedWork|hasTaskCapacity|organisationId/.test(taster.slice(0, taster.indexOf('export async function sendTasterEmail'))));
});

check('the edge limiter also covers the endpoint', () => {
    assert.match(read('netlify.toml'), /function = "rate-limit"\s*\n\s*path = "\/\.netlify\/functions\/site-audit-public"/);
    assert.match(read('netlify/edge-functions/rate-limit.ts'), /'\/\.netlify\/functions\/site-audit-public': \{ maxAttempts: \d+/);
});

console.log('\nThe email');

check('one transactional email, saying why it came and that nobody was added to a list', () => {
    const t = getTemplateDefault('site_taster_result')!;
    assert.ok(t && t.transactional);
    const m = mergeTemplateParts(t, { site: { host: 'acme.example', score: '64/100' }, link: { action_url: 'https://bemoreswan.com/mystery-shopper?r=1&t=abc' } });
    assert.strictEqual(m.subject, 'Your website scored 64/100 on first impression');
    assert.ok(m.body.includes('acme.example') && m.body.includes('mystery-shopper?r=1&amp;t=abc'));
    assert.ok(!/\{\{/.test(m.body + m.subject));
    assert.match(m.body, /have not added you to any mailing list/);
});

console.log('\nThe page (assistant.html?role=mystery_shopper + src/public/site-taster.js)');

const taster = read('src/public/site-taster.js');
const assistantPage = read('assistant.html');

check('the check lives on the assistant\'s own page, and the old standalone page is gone', () => {
    assert.match(assistantPage, /<script src="\/src\/public\/site-taster\.js" defer><\/script>/);
    assert.match(assistantPage, /const TASTER_ROLE = 'mystery_shopper';/);
    assert.match(assistantPage, /roleKey === TASTER_ROLE \? '<div id="site-taster-host"><\/div>' : ''/);
    assert.ok(!existsSync(join(root, 'mystery-shopper.html')));
    assert.ok(!read('scripts/build-seo-html.mjs').includes('mystery-shopper.html'));
    assert.ok(!read('sitemap.xml').includes('/mystery-shopper<'));
});

check('both old URLs redirect permanently to the new page', () => {
    const toml = read('netlify.toml');
    for (const from of ['/mystery-shopper', '/mystery-shopper.html']) {
        assert.ok(new RegExp(`from = "${from.replace('.', '\\.')}"\\s*\\n\\s*to = "/assistant\\.html\\?role=mystery_shopper"\\s*\\n\\s*status = 301`).test(toml), from);
    }
});

check('the footer link and the result email point at the new page', () => {
    assert.match(read('components/footer.html'), /href="assistant\.html\?role=mystery_shopper#free-website-check"[^>]*data-i18n="footer\.free_website_check"/);
    for (const l of ['en', 'de', 'es', 'fr', 'pt']) assert.ok(JSON.parse(read(`locales/${l}.json`)).footer.free_website_check, l);
    assert.match(read('src/utils/site-audit.ts'), /\/assistant\.html\?role=mystery_shopper&r=\$\{runId\}&t=\$\{token\}/);
});

check('while the role is not public, the check still shows (an emailed result must never land on "not found")', () => {
    assert.match(assistantPage, /if \(!c && roleKey === TASTER_ROLE\) \{[\s\S]{0,400}mountTaster\(root, roleKey, \{ name: 'Mystery Shopper', comingSoon: false \}, 'h1'\);/);
});

check('the result\'s button is the page\'s own button (hire / waitlist / get started)', () => {
    assert.match(assistantPage, /window\.BmsSiteTaster\.mount\(host, \{ ctaHtml: cta\(roleKey, c, true\), headingTag \}\)/);
});

check('the copy makes no claim the taster does not do', () => {
    const visible = taster.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\d+\s?%/.test(visible.replace(/width:\d+%/g, '')), 'no percentages');
    assert.ok(!/ChatGPT|Perplexity|guarantee|the moment/i.test(visible));
    assert.match(visible, /We email you your result, once\. We don't add you to a mailing list or keep your address\./);
    assert.match(visible, /alerts you when a rival changes/);
    assert.match(visible, /AI assistants are likely to read your site/);
    assert.match(visible, /an unchanged page keeps exactly the same grade/);
});

check('everything rendered from the server is escaped', () => {
    const render = taster.slice(taster.indexOf('function renderResult'), taster.indexOf('async function poll'));
    for (const field of ['r.summary', 'fix.problem', 'fix.currentText', 'fix.suggestedText', 'fix.location']) {
        assert.ok(render.includes(`esc(${field}`), field);
    }
});

console.log(`\n${passed}/${total} passed`);
