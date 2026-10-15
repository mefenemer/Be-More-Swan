// tests/site-hosting.test.ts
// The Website Assistant, step 3a (docs/website-assistant-plan.md §5.2, §7): publishing on
// <name>.bemoreswan.site — addresses, who may be served, what is served, the publish gate, the
// separate sites-host project, "Report this site", and the admin's power to take a site offline.
//
// Run:  npx tsx tests/site-hosting.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    canonicalJson, cleanSiteSlugInput, DEFAULT_SITES_DOMAIN, isReportReason, sameDefinition, siteOrigin, sitesDomain,
    siteSlugProblem, siteVisibleText, slugFromHost, suggestSiteSlug,
} from '../src/utils/site-hosting';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { starterSite } from '../src/utils/site-draft';
import { publishBlocker, type SiteRow } from '../src/utils/site-store';
import { appOrigin, keyMatches } from '../netlify/functions/site-serve';
import { renderSitePage } from '../src/utils/site-render';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const business = { name: 'Willowbrook Coffee', industry: null, description: 'Fresh-roasted coffee for independent cafés in Yorkshire.', audience: null, websiteUrl: null, email: 'hello@willowbrook.example' };
const theme = normaliseSiteDefinition({}).definition.theme;
const site = (over: Partial<SiteRow>): SiteRow => ({
    id: 1, organisationId: 1, aiAssistantId: 1, createdBy: null, status: 'draft', draft: {}, slug: 'willowbrook-coffee', credit: true,
    draftingAt: null, draftNote: null, createdAt: new Date(), updatedAt: new Date(), publishedVersion: null, publishedAt: null,
    suspendedAt: null, suspendedReason: null, ...over,
});

console.log('\nAddresses');

check('the sites domain is its own domain, never bemoreswan.com', () => {
    assert.strictEqual(DEFAULT_SITES_DOMAIN, 'bemoreswan.site');
    assert.strictEqual(sitesDomain({}), 'bemoreswan.site');
    assert.strictEqual(sitesDomain({ SITES_DOMAIN: 'Staging-Sites.example.' }), 'staging-sites.example');
    assert.strictEqual(sitesDomain({ SITES_DOMAIN: 'not a domain' }), 'bemoreswan.site');
    assert.strictEqual(siteOrigin('willowbrook', 'bemoreswan.site'), 'https://willowbrook.bemoreswan.site');
});

check('a business name becomes a usable address', () => {
    assert.strictEqual(suggestSiteSlug('Willowbrook Coffee'), 'willowbrook-coffee');
    assert.strictEqual(suggestSiteSlug('Café Rouge & Co'), 'cafe-rouge-and-co');
    assert.strictEqual(suggestSiteSlug("Joe's Barbers"), 'joes-barbers');
    for (const n of ['X', 'Shop', 'PayPal Login', '', '!!!']) assert.strictEqual(siteSlugProblem(suggestSiteSlug(n)), null, n);
});

check('addresses: shape rules, in plain words', () => {
    assert.strictEqual(siteSlugProblem('willowbrook'), null);
    assert.strictEqual(siteSlugProblem('the-black-swan'), null, 'an ordinary pub name is fine');
    assert.strictEqual(siteSlugProblem('willowbrook-shop'), null, 'generic words are fine as PART of a name');
    assert.match(siteSlugProblem('ab')!, /at least 3/);
    assert.match(siteSlugProblem('a'.repeat(41))!, /40/);
    assert.match(siteSlugProblem('Willow_brook')!, /lower-case/);
    assert.match(siteSlugProblem('-willow')!, /hyphen/);
    assert.match(siteSlugProblem('xn--80ak6aa92e')!, /two hyphens/, 'punycode look-alikes are refused');
    assert.match(siteSlugProblem('12345')!, /letter/);
});

check('reserved and phishing addresses are refused', () => {
    for (const s of ['www', 'admin', 'login', 'shop', 'swan', 'bemoreswan', 'paypal-login', 'verify-account', 'hmrc-refund', 'secure-barclays', 'my-google-page']) {
        assert.match(siteSlugProblem(s) ?? '', /reserved/, s);
    }
});

check('typed addresses are cleaned (the domain typed on the end is dropped)', () => {
    assert.strictEqual(cleanSiteSlugInput('  Willowbrook.bemoreswan.site ', 'bemoreswan.site'), 'willowbrook');
    assert.strictEqual(cleanSiteSlugInput('https://willowbrook.bemoreswan.site/about', 'bemoreswan.site'), 'willowbrook');
});

check('a Host names a site only when it is exactly one label under the sites domain', () => {
    const d = 'bemoreswan.site';
    assert.strictEqual(slugFromHost('Willowbrook.bemoreswan.site', d), 'willowbrook');
    assert.strictEqual(slugFromHost('willowbrook.bemoreswan.site:443', d), 'willowbrook');
    assert.strictEqual(slugFromHost('bemoreswan.site', d), null);
    assert.strictEqual(slugFromHost('www.bemoreswan.site', d), null);
    assert.strictEqual(slugFromHost('a.b.bemoreswan.site', d), null);
    assert.strictEqual(slugFromHost('willowbrook.bemoreswan.com', d), null);
    assert.strictEqual(slugFromHost('evilbemoreswan.site', d), null);
    assert.strictEqual(slugFromHost(undefined, d), null);
});

console.log('\nPublishing');

check('publish is refused while suspended, without an address, or with [placeholders] left', () => {
    const clean = starterSite(business, theme);
    assert.strictEqual(publishBlocker(site({}), clean), null);
    assert.match(publishBlocker(site({ status: 'suspended' }), clean)!, /taken offline/);
    assert.match(publishBlocker(site({ slug: null }), clean)!, /address/);
    const holes = starterSite({ ...business, email: null, description: null }, theme);
    assert.match(publishBlocker(site({}), holes)!, /square brackets/);
});

check('"unpublished changes" compares meaning, not key order', () => {
    const a = starterSite(business, theme);
    const reorder = (v: unknown): unknown => Array.isArray(v) ? v.map(reorder)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;
    const b = reorder(a) as typeof a;
    assert.notStrictEqual(JSON.stringify(a), JSON.stringify(b), 'the copy really is in a different order');
    assert.ok(sameDefinition(a, b));
    assert.strictEqual(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
    const c = normaliseSiteDefinition({ ...a, footer: { text: 'Changed' } }).definition;
    assert.ok(!sameDefinition(a, c));
    assert.ok(!sameDefinition(null, a));
});

check('the safety check reads what a visitor reads, not addresses or colours', () => {
    const text = siteVisibleText(starterSite(business, theme));
    assert.ok(text.includes('Willowbrook Coffee'));
    assert.ok(text.includes('Fresh-roasted coffee'));
    assert.ok(!text.includes('/contact'), 'links are not prose');
    assert.ok(!/#[0-9a-f]{6}/i.test(text), 'colours are not prose');
});

check('sites.ts: publish runs the safety check on every word BEFORE freezing a version', () => {
    const api = read('netlify/functions/sites.ts');
    const pub = api.slice(api.indexOf("if (action === 'publish')"), api.indexOf("if (action === 'unpublish')"));
    assert.ok(pub.indexOf('publishBlocker(site, definition)') < pub.indexOf('enforcePromptModeration('));
    assert.ok(pub.indexOf('enforcePromptModeration(') < pub.indexOf('publishSite('));
    assert.ok(pub.includes('siteVisibleText(definition)'));
});

check('publishing is a click on the Website tab only — the chat cards never send it', () => {
    const chat = read('src/components/chat-session.js');
    for (const a of ['publish', 'unpublish', 'address', 'restore']) assert.ok(!chat.includes(`action: '${a}'`), a);
    const prompt = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(prompt.includes('You cannot publish, take the site offline or choose its address'));
    assert.ok(read('src/utils/site-store.ts').includes('you cannot do them from chat'));
});

check('publishSite freezes a version, never serves the draft, and keeps only the newest versions', () => {
    const store = read('src/utils/site-store.ts');
    const fn = store.slice(store.indexOf('export async function publishSite'), store.indexOf('export async function unpublishSite'));
    assert.ok(fn.includes('publishBlocker(site, definition)'), 'the gate is re-checked inside');
    assert.ok(fn.includes('db.transaction('));
    assert.ok(fn.includes('tx.insert(siteVersions)'));
    assert.ok(fn.includes("ne(sites.status, 'suspended')"), 'a suspension that lands mid-publish wins');
    assert.ok(fn.includes('KEEP_VERSIONS'));
    const restore = store.slice(store.indexOf('export async function restoreVersionToDraft'), store.indexOf('export async function hasUnpublishedChanges'));
    assert.ok(restore.includes('draft: definition') && !restore.includes('publishedVersion'), 'restoring a version only changes the draft');
});

check('the editor has the Publish card, with confirmations, and nothing publishes without one', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('function publishCard()'));
    for (const a of ["{ action: 'publish' }", "{ action: 'unpublish' }", "{ action: 'address', slug }", "{ action: 'restore', version:"]) assert.ok(ed.includes(a), a);
    const pub = ed.slice(ed.indexOf("if (t('[data-site-publish]'))"), ed.indexOf("if (t('[data-site-unpublish]'))"));
    assert.ok(pub.indexOf('confirmModal(') < pub.indexOf("action: 'publish'"));
    assert.ok(ed.includes('Your site has been taken offline by Be More Swan'));
});

console.log('\nServing');

check('site-serve answers nothing without the shared key', () => {
    assert.strictEqual(keyMatches(undefined, 'a-long-enough-secret-value'), false);
    assert.strictEqual(keyMatches('wrong-but-same-length-xxxxxx', 'a-long-enough-secret-value'), false);
    assert.strictEqual(keyMatches('short', 'short'), false, 'a short secret is treated as no secret');
    assert.strictEqual(keyMatches('a-long-enough-secret-value', undefined), false, 'fails closed when unset');
    assert.strictEqual(keyMatches('a-long-enough-secret-value', 'a-long-enough-secret-value'), true);
    const fn = read('netlify/functions/site-serve.ts');
    assert.ok(fn.indexOf("keyMatches(h['x-site-serve-key']") < fn.indexOf('getDb()'), 'the key is checked before anything is read');
});

check('site-serve: published version only, no scripts, no framing, suspended = 410', () => {
    const fn = read('netlify/functions/site-serve.ts');
    assert.ok(fn.includes('publishedDefinition(db, site,'));
    assert.ok(!fn.includes('definitionOf('), 'the draft is never served');
    assert.ok(fn.includes("default-src 'none'") && fn.includes("frame-ancestors 'none'") && !fn.includes('script-src'));
    assert.ok(fn.includes("notice(410, 'This site is unavailable'"));
    assert.ok(fn.includes('report-site.html?site='));
});

check('a published page is indexable, with a canonical on its own address and the report link', () => {
    const def = starterSite(business, theme);
    const html = renderSitePage(def, '/', { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: 'https://bemoreswan.com/report-site.html?site=willowbrook', creditUrl: 'https://bemoreswan.com/assistant.html?role=website_assistant' }).html;
    assert.ok(!html.includes('noindex'));
    assert.ok(html.includes('<link rel="canonical" href="https://willowbrook.bemoreswan.site/">'));
    assert.ok(html.includes('report-site.html?site=willowbrook'));
    assert.ok(html.includes('Made with Be More Swan'));
    assert.ok(!/<script(?![^>]*application\/ld\+json)/.test(html));
});

check('appOrigin is the app, and only an https origin', () => {
    assert.strictEqual(appOrigin({ URL: 'https://bemoreswan.com/' }), 'https://bemoreswan.com');
    assert.strictEqual(appOrigin({ URL: 'javascript:alert(1)' }), 'https://bemoreswan.com');
    assert.strictEqual(appOrigin({}), 'https://bemoreswan.com');
});

check('sites-host: one edge function that forwards host + key, GET/HEAD only, and drops cookies', () => {
    const edge = read('sites-host/edge-functions/serve.ts');
    assert.ok(edge.includes("'x-site-host': url.host") && edge.includes("'x-site-serve-key': key"));
    assert.ok(edge.includes("request.method !== 'GET' && request.method !== 'HEAD'"));
    assert.ok(edge.includes("headers.delete('set-cookie')"));
    assert.ok(edge.includes("if (!key) return new Response("), 'fails closed without the key');
    const toml = read('sites-host/netlify.toml');
    assert.ok(toml.includes('function = "serve"') && toml.includes('path = "/*"'));
    assert.ok(toml.includes('SITE_SERVE_SECRET'));
});

check('the sites-host folder is not served by bemoreswan.com', () => {
    const toml = read('netlify.toml');
    const rule = toml.slice(toml.indexOf('from = "/sites-host/*"'), toml.indexOf('from = "/sites-host/*"') + 120);
    assert.ok(rule.includes('status = 404') && rule.includes('force = true'));
});

console.log('\nReports and moderation');

check('report reasons are a closed list matching the database', () => {
    const sqlFile = read('db/z-website-hosting.sql');
    for (const r of ['scam', 'impersonation', 'harmful', 'copyright', 'other']) {
        assert.ok(isReportReason(r));
        assert.ok(sqlFile.includes(`'${r}'`));
    }
    assert.ok(!isReportReason('toString'));
});

check('site-reports: bots are turned away before anything is written, and it is rate-limited', () => {
    const fn = read('netlify/functions/site-reports.ts');
    assert.ok(fn.indexOf("String(body.website || '')") < fn.indexOf('getDb()'));
    assert.ok(fn.indexOf('checkRateLimit(') < fn.indexOf('db.insert(siteReports)'));
    const page = read('report-site.html');
    assert.ok(page.includes('/.netlify/functions/site-reports') && page.includes('id="rs-website"'));
    assert.ok(page.includes('noindex'));
});

check('admin: Hosted Sites under Trust, platform_config, reason required to take a site down, audit-logged', () => {
    const html = read('admin.html');
    assert.ok(html.includes('id="view-hosted-sites"'));
    assert.ok(html.includes("{ view: 'hosted-sites',    icon: '🌐', label: 'Hosted Sites',     perm: 'platform_config',"));
    assert.ok(html.includes("if (view === 'hosted-sites')   loadHostedSites();"));
    const fn = read('netlify/functions/admin-sites.ts');
    assert.ok(fn.includes("hasPermission(row?.role, 'platform_config')"));
    assert.ok(fn.includes("if (!reason) return json(400"));
    assert.strictEqual((fn.match(/action: 'hosted_site_moderation'/g) || []).length, 3);
    assert.ok(read('src/utils/admin-audit.ts').includes("| 'hosted_site_moderation'"));
});

check('the migration adds versions, reports and the publish columns; the schema mirrors them', () => {
    const sqlFile = read('db/z-website-hosting.sql');
    for (const s of ['CREATE TABLE IF NOT EXISTS site_versions', 'CREATE TABLE IF NOT EXISTS site_reports', 'ADD COLUMN IF NOT EXISTS published_version', 'ADD COLUMN IF NOT EXISTS suspended_reason', 'site_versions_site_version_uq']) assert.ok(sqlFile.includes(s), s);
    const schema = read('db/schema.ts');
    assert.ok(schema.includes('export const siteVersions = pgTable("site_versions"'));
    assert.ok(schema.includes('export const siteReports = pgTable("site_reports"'));
    assert.ok(schema.includes('publishedVersion: integer("published_version")'));
});

console.log(`\n${passed}/${total} passed`);
