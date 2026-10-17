// tests/site-domains.test.ts
// A business's own domain for its site (decision D2: Netlify aliases to start — owner, 2026-10-17).
//
// Run:  npx tsx tests/site-domains.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanDomainInput, customDomainsConfig, dnsPointsAtUs, dnsRecordsFor, isRegistrable, NETLIFY_APEX_IP } from '../src/utils/site-domains';
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

    console.log(`\n${passed}/${total} passed\n`);
})();
