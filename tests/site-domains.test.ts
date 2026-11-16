// tests/site-domains.test.ts
// A business's own domain for its site (decision D2: Netlify aliases to start — owner, 2026-10-17).
//
// Run:  npx tsx tests/site-domains.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanDomainInput, customDomainsConfig, DETAIL_DNS_RIGHT_PREFIX, DETAIL_HELD_ELSEWHERE, DETAIL_OUR_SIDE, dnsHostFromNameservers, dnsPointsAtUs, dnsRecordsFor, domainPhase, heldByAnotherNetlifySite, isRegistrable, lookupDomainRegistry, rdapBaseFor, NETLIFY_APEX_IP, NetlifyApiError, notPointingDetail, parseRdap, summariseRegistry } from '../src/utils/site-domains';
import { assessProviders } from '../src/utils/provider-balance';
import { siteSlugProblem } from '../src/utils/site-hosting';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

(async () => {
    console.log('\nWhat they type');

    await check('a bare domain is served at www, the bare one redirecting; a subdomain as it is', () => {
        assert.deepStrictEqual(cleanDomainInput('  https://Example.co.uk/about '), { domain: 'www.example.co.uk', alt: 'example.co.uk' });
        assert.deepStrictEqual(cleanDomainInput('www.example.com'), { domain: 'www.example.com', alt: 'example.com' });
        assert.deepStrictEqual(cleanDomainInput('shop.example.com'), { domain: 'shop.example.com', alt: null });
        assert.strictEqual(isRegistrable('a.b.example.co.uk'), 'example.co.uk');
    });
    await check('never ours, never an IP, never nonsense', () => {
        for (const bad of ['bemoreswan.com', 'x.bemoreswan.site', 'mysite.netlify.app', '192.168.0.1', 'nodot', 'a..b.com', '-x.com', '']) {
            assert.ok('error' in cleanDomainInput(bad), bad);
        }
        assert.ok(siteSlugProblem('domains'), 'the custom-domains project\'s own address is reserved');
    });

    console.log('\nThe DNS settings');

    await check('www → a CNAME to our project; the bare domain → an A record to Netlify', () => {
        const r = dnsRecordsFor({ domain: 'www.example.co.uk', altDomain: 'example.co.uk' }, 'bms-domains.netlify.app');
        assert.deepStrictEqual(r.map((x) => [x.type, x.name, x.value]), [['CNAME', 'www', 'bms-domains.netlify.app'], ['A', '@', NETLIFY_APEX_IP]]);
        assert.deepStrictEqual(dnsRecordsFor({ domain: 'shop.example.com', altDomain: null }, 't.netlify.app').map((x) => x.name), ['shop']);
    });
    await check('pointing at us: the CNAME, or only Netlify\'s address — a leftover A record is not enough', async () => {
        const fake = (cname: string[] | null, a: string[] | null) => ({
            resolveCname: async () => { if (!cname) throw new Error('ENODATA'); return cname; },
            resolve4: async () => { if (!a) throw new Error('ENODATA'); return a; },
        });
        assert.strictEqual((await dnsPointsAtUs('www.x.com', 'bms.netlify.app', fake(['BMS.netlify.app.'], null))).ok, true);
        assert.strictEqual((await dnsPointsAtUs('www.x.com', 'bms.netlify.app', fake(['old-host.example'], null))).ok, false);
        assert.strictEqual((await dnsPointsAtUs('x.com', 'bms.netlify.app', fake(null, [NETLIFY_APEX_IP]))).ok, true);
        assert.strictEqual((await dnsPointsAtUs('x.com', 'bms.netlify.app', fake(null, [NETLIFY_APEX_IP, '1.2.3.4']))).ok, false);
        assert.deepStrictEqual(await dnsPointsAtUs('x.com', 'bms.netlify.app', fake(null, null)), { ok: false, found: 'nothing yet' });
    });
    await check('switched off until all three settings are there', () => {
        assert.strictEqual(customDomainsConfig({}).ready, false);
        assert.strictEqual(customDomainsConfig({ NETLIFY_API_TOKEN: 't', CUSTOM_DOMAINS_SITE_ID: 'id', CUSTOM_DOMAINS_TARGET: 'bms-domains.netlify.app' }).ready, true);
        assert.strictEqual(customDomainsConfig({ NETLIFY_API_TOKEN: 't', CUSTOM_DOMAINS_SITE_ID: 'id', CUSTOM_DOMAINS_TARGET: 'evil.example' }).ready, false);
    });

    console.log('\nThe flow');

    await check('aliases only once DNS points here, under a lock; live only when https answers as THIS site', () => {
        const d = read('src/utils/site-domains.ts');
        assert.ok(d.indexOf("if (!main.ok) return set({") < d.indexOf('await changeAliases(db, [row.domain'), 'never an alias before its DNS');
        assert.ok(d.includes("pg_advisory_xact_lock(hashtext('bms_custom_domain_aliases'))"));
        assert.ok(d.includes('answers = r.body.trim() === domainCheckBody(row.siteId);') && d.includes('safeFetchText(`https://${row.domain}${DOMAIN_CHECK_PATH}`'));
        assert.ok(d.includes("const lapsed = h.status === 'pending_dns' &&"), 'an unproven claim lapses');
    });
    await check('a refused certificate request does not hold the domain at "waiting" once its aliases are on', () => {
        const d = read('src/utils/site-domains.ts');
        const start = d.indexOf("if (row.status === 'pending_dns') {");
        const end = d.indexOf("return set({ status: 'securing'", start);
        assert.ok(start > -1 && end > start, 'pending_dns branch found');
        const branch = d.slice(start, end);
        const aliasTry = branch.slice(branch.indexOf('await changeAliases(db, [row.domain'), branch.indexOf("console.error('[site-domains] could not add aliases'"));
        assert.ok(aliasTry.length > 0 && !aliasTry.includes('requestCertificate'), 'the certificate request is not inside the alias try');
        assert.ok(branch.includes('try { await requestCertificate(); }\n        catch (err) { console.error('), 'its own try, logged, then on to securing');
    });
    await check('serving: one address per site, page views redirected, forms answered in place; cache tagged per site', () => {
        const s = read('netlify/functions/site-serve.ts');
        assert.ok(s.includes("const resolved = await resolveSiteHost(getDb(), h['x-site-host']);"));
        assert.ok(s.includes('if (resolved?.redirectTo && !isPost && path !== DOMAIN_CHECK_PATH) {'));
        assert.ok(s.includes("const origin = resolved?.origin ?? siteOrigin(slug);"));
        assert.ok(s.includes("const slug = resolved?.slug ?? null;\n    return { ...res"), 'tag from the resolved site');
        assert.ok(s.indexOf("keyMatches(h['x-site-serve-key']") < s.indexOf('resolveSiteHost(getDb()'), 'no database work before the key');
    });
    await check('owner or admin only; the Publish card shows the settings to add; SQL creates the table', () => {
        const api = read('netlify/functions/sites.ts');
        assert.ok(api.includes("if (role !== 'owner' && role !== 'admin') return json(403, { error: 'Only the workspace owner or an admin can connect a domain.' });"));
        const ed = read('src/components/assistant-site-editor.js');
        assert.ok(ed.includes('function domainBlock()') && ed.includes("btn('data-site-domain-add', 'Connect', true)") && ed.includes("btn('data-site-domain-check', 'Check now', true)"));
        assert.ok(read('db/z-site-domains.sql').includes('CREATE UNIQUE INDEX IF NOT EXISTS site_domains_domain_uq ON site_domains (domain) WHERE status <> \'removed\';'));
    });

    console.log('\nWhen it gets stuck (Restorative Futures, 2026-11-13)');

    await check('the heading follows the phase: never "waiting for your DNS" when the DNS is right', () => {
        assert.strictEqual(domainPhase({ status: 'pending_dns', statusDetail: null }), 'needs_dns');
        assert.strictEqual(domainPhase({ status: 'pending_dns', statusDetail: 'www.x.com doesn\'t point here yet (found: nothing yet).' }), 'needs_dns');
        assert.strictEqual(domainPhase({ status: 'pending_dns', statusDetail: DETAIL_OUR_SIDE }), 'connecting');
        assert.strictEqual(domainPhase({ status: 'securing', statusDetail: 'x' }), 'securing');
        assert.strictEqual(domainPhase({ status: 'live', statusDetail: 'x' }), 'live');
        assert.ok(DETAIL_OUR_SIDE.startsWith(DETAIL_DNS_RIGHT_PREFIX) && /don't need to change anything/.test(DETAIL_OUR_SIDE));
        const d = read('src/utils/site-domains.ts');
        assert.ok(d.includes("statusDetail: 'Your DNS is right. Setting up the secure (https) connection"), 'the step to securing still says the DNS is right');
    });
    await check('our failure: the owner is told to do nothing, the operator is emailed once per stuck spell', () => {
        const d = read('src/utils/site-domains.ts');
        const i = d.indexOf("console.error('[site-domains] could not add aliases'");
        const branch = d.slice(i, d.indexOf('return set({ statusDetail: DETAIL_OUR_SIDE });', i));
        assert.ok(i > -1 && branch.includes('if (row.statusDetail !== DETAIL_OUR_SIDE) {') && branch.includes('await alertOperator('), 'alerts only on the first failure');
        assert.ok(branch.includes('err.status === 401 || err.status === 403') && branch.includes('NETLIFY_API_TOKEN'), 'a rejected token says what to replace');
        assert.ok(!d.includes("we\\'ll try again when you next check"), 'never asks the owner to keep pressing');
        assert.ok(d.includes("} catch (err) { console.error('[site-domains] OPERATOR ALERT FAILED"), 'a failed alert never breaks the check');
    });
    await check('rechecked every 10 minutes without anyone pressing; the owner is emailed when live', () => {
        assert.ok(/\[functions\.check-site-domains\]\n\s+schedule = "3-59\/10 \* \* \* \*"/.test(read('netlify.toml')));
        assert.ok(/run-site-domain-checks\s+600\s+120/.test(read('.github/workflows/staging-crons.yml')), 'staging is poked too');
        const fn = read('netlify/functions/check-site-domains.ts');
        assert.ok(fn.includes('checkDueDomains(db, async (row, slug) => {') && fn.includes('await notifyDomainLive(db, row.siteId, row.domain);'));
        const trig = read('netlify/functions/run-site-domain-checks.ts');
        assert.ok(trig.includes("import { runSiteDomainChecks } from './check-site-domains';") && trig.includes('if (token !== secret)'), 'staging trigger is secret-gated');
        const d = read('src/utils/site-domains.ts');
        assert.ok(d.includes("or(eq(siteDomains.status, 'securing'), and(eq(siteDomains.status, 'pending_dns'), gt(siteDomains.createdAt, since)))"), 'only domains on their way, for 72h');
        const api = read('netlify/functions/sites.ts');
        assert.ok(api.includes("if (before !== 'live' && after.status === 'live') {") && api.includes('await notifyDomainLive(db, site.id, after.domain);'), '"Check now" emails too');
    });
    await check('the panel says what the check found, and hides the records once the DNS is right', () => {
        const ed = read('src/components/assistant-site-editor.js');
        assert.ok(ed.includes("await publishAction({ action: 'domain_check' }, domainCheckNote);") && !ed.includes("'Checked.'"));
        assert.ok(ed.includes("text: typeof okText === 'function' ? okText(state.data) : okText"));
        assert.ok(ed.includes("const records = phase === 'needs_dns' ||"));
        assert.ok(ed.includes("phase === 'connecting' ? 'DNS is right — connecting'"));
    });
    await check('the provider monitor emails when Netlify rejects our token; a blip is not an alert', () => {
        const base = { fal: { status: 'not_configured' }, falEvidence: { failures: 0, organisations: 0, latestAt: null, sample: null, lastSuccessAt: null }, anthropic: { status: 'not_configured' } } as unknown as Parameters<typeof assessProviders>[0];
        const rejected = assessProviders({ ...base, netlifyDomains: { status: 'key_rejected', httpStatus: 401 } });
        assert.deepStrictEqual(rejected.map((p) => [p.provider, p.severity]), [['netlify_domains', 'down']]);
        assert.ok(rejected[0].lines.some((l) => l.includes('NETLIFY_API_TOKEN')));
        assert.deepStrictEqual(assessProviders({ ...base, netlifyDomains: { status: 'error', message: 'timeout' } }), []);
        assert.deepStrictEqual(assessProviders({ ...base, netlifyDomains: { status: 'ok' } }), []);
        assert.ok(read('netlify/functions/check-provider-balances.ts').includes('probeDomainsAccess(),'));
    });

    console.log('\nAnother Netlify site, and who manages the domain');

    await check('still pointing at another Netlify site: says change the record AND take it off that site', () => {
        const row = { domain: 'www.restorativefutures.co.uk', altDomain: 'restorativefutures.co.uk' };
        const t = notPointingDetail(row, 'CNAME restorative-futures.netlify.app', 'bms-domains.netlify.app');
        assert.ok(t.includes('another Netlify website (restorative-futures.netlify.app)') && t.includes('remove restorativefutures.co.uk from that site') && t.includes('Check now straight away'));
        assert.ok(notPointingDetail(row, 'CNAME old.webador.com', 'bms-domains.netlify.app').startsWith("www.restorativefutures.co.uk doesn't point here yet (found: CNAME old.webador.com)"));
        assert.ok(notPointingDetail(row, 'nothing yet', 'bms-domains.netlify.app').includes('we check every 10 minutes'));
    });
    await check('DNS right but held by another Netlify site: its own phase and words, not "our fault"', () => {
        assert.strictEqual(heldByAnotherNetlifySite(new NetlifyApiError(422, 'Domain already in use by another site')), true);
        assert.strictEqual(heldByAnotherNetlifySite(new NetlifyApiError(422, 'Invalid SSL request')), false);
        assert.strictEqual(heldByAnotherNetlifySite(new NetlifyApiError(401, 'Access Denied')), false);
        const detail = DETAIL_HELD_ELSEWHERE('restorativefutures.co.uk');
        assert.ok(detail.startsWith('Your DNS is right, but restorativefutures.co.uk is still attached to another Netlify website'));
        assert.strictEqual(domainPhase({ status: 'pending_dns', statusDetail: detail }), 'held_elsewhere');
        const d = read('src/utils/site-domains.ts');
        assert.ok(d.indexOf('if (heldByAnotherNetlifySite(err)) {') < d.indexOf('if (row.statusDetail !== DETAIL_OUR_SIDE) {'), 'checked before the our-side message');
    });
    await check('nameservers → whose DNS panel; a reseller on a wholesale registrar wins (Webador on Openprovider)', () => {
        assert.strictEqual(dnsHostFromNameservers(['ns05.domaincontrol.com.']), 'GoDaddy');
        assert.strictEqual(dnsHostFromNameservers(['kate.ns.cloudflare.com']), 'Cloudflare');
        assert.strictEqual(dnsHostFromNameservers(['dns1.p04.nsone.net']), 'Netlify DNS');
        assert.strictEqual(dnsHostFromNameservers(['ns.unknown-host.example']), null);
        // The real Nominet answer for restorativefutures.co.uk, trimmed.
        const rdap = parseRdap({ entities: [
            { roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Hosting Concepts B.V.']]] },
            { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', '']]] },
            { roles: ['reseller'], vcardArray: ['vcard', [['fn', {}, 'text', ''], ['org', {}, 'text', 'Webador']]] },
        ], events: [{ eventAction: 'registration', eventDate: '2026-06-14T15:26:20Z' }, { eventAction: 'expiration', eventDate: '2027-06-14T15:26:20Z' }] });
        assert.deepStrictEqual(rdap, { reseller: 'Webador', registrar: 'Hosting Concepts B.V.', expiresAt: '2027-06-14T15:26:20.000Z' });
        assert.deepStrictEqual(summariseRegistry(['ns1.openprovider.nl.'], rdap), { dnsManagedBy: 'Webador', boughtThrough: 'Webador', expiresAt: '2027-06-14T15:26:20.000Z', netlifyDns: false });
        assert.strictEqual(summariseRegistry(['ns1.domaincontrol.com'], { reseller: null, registrar: 'GoDaddy.com, LLC', expiresAt: null }).dnsManagedBy, 'GoDaddy');
        assert.deepStrictEqual(parseRdap(null), { reseller: null, registrar: null, expiresAt: null });
    });
    await check('the lookup never throws, asks the registrable domain, and is cached', async () => {
        let calls = 0;
        const deps = { resolveNs: async (h: string) => { calls++; assert.strictEqual(h, 'cache-test.co.uk'); return ['ns1.openprovider.nl']; }, fetchJson: async (u: string) => { if (u.includes('data.iana.org')) return { services: [[['uk'], ['https://rdap.nominet.uk/uk/']]] }; assert.strictEqual(u, 'https://rdap.nominet.uk/uk/domain/cache-test.co.uk'); return { entities: [{ roles: ['reseller'], vcardArray: ['vcard', [['org', {}, 'text', 'Webador']]] }] }; } };
        const a = await lookupDomainRegistry('www.cache-test.co.uk', deps);
        const b = await lookupDomainRegistry('cache-test.co.uk', deps);
        assert.strictEqual(a?.dnsManagedBy, 'Webador'); assert.deepStrictEqual(a, b); assert.strictEqual(calls, 1, 'second call served from cache');
        const none = await lookupDomainRegistry('broken-test.com', { resolveNs: async () => { throw new Error('SERVFAIL'); }, fetchJson: async () => { throw new Error('RDAP 500'); } });
        assert.strictEqual(none, null);
    });
    await check('the RDAP server comes from IANA\'s list for the ending; none for an ending without RDAP', () => {
        const services: Array<[string[], string[]]> = [[['uk'], ['https://rdap.nominet.uk/uk/']], [['com', 'net'], ['http://x.example/', 'https://rdap.verisign.com/com/v1/']]];
        assert.strictEqual(rdapBaseFor('restorativefutures.co.uk', services), 'https://rdap.nominet.uk/uk/');
        assert.strictEqual(rdapBaseFor('github.com', services), 'https://rdap.verisign.com/com/v1/', 'https preferred');
        assert.strictEqual(rdapBaseFor('startup.io', services), null);
        assert.ok(!read('src/utils/site-domains.ts').includes('https://rdap.org/'), 'not the middleman that 403s Node');
    });
    await check('the panel names the DNS host, warns before renewal, and says keep the old site until Live', () => {
        const ed = read('src/components/assistant-site-editor.js');
        assert.ok(ed.includes('${whereToEdit(d)}') && ed.includes("is managed by <strong>${esc(r.dnsManagedBy)}</strong>"));
        assert.ok(ed.includes('const soon = days != null && days <= 60;') && ed.includes('your website goes offline'));
        assert.ok(ed.includes('Keep it running until this says <strong>Live</strong>'));
        assert.ok(ed.includes("phase === 'held_elsewhere' ? 'Still attached to another Netlify site'"));
        assert.ok(read('netlify/functions/sites.ts').includes('registry: ownDomain ? await lookupDomainRegistry(ownDomain.altDomain || ownDomain.domain) : null'));
    });

    console.log(`\n${passed}/${total} passed\n`);
})();
