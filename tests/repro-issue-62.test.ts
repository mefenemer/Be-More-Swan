// tests/repro-issue-62.test.ts
// Fix pipeline #62 (prod, owner report, 2026-11-16): Admin ▸ Hosted Sites showed
// "restorative-futures.bemoreswan.site · Live" for site 3, which has been live at www.restorativefutures.co.uk
// since 2026-11-13 (site_domains row 2, status 'live'; the bemoreswan.site address redirects there).
// admin-sites.ts built every address from the slug and never read site_domains.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as hosting from '../src/utils/site-hosting';

const siteAddresses = (hosting as any).siteAddresses;
assert.strictEqual(typeof siteAddresses, 'function', 'there is one rule for the address a hosted site is served at');

// Site 3 as it is on prod.
const rf = siteAddresses('restorative-futures', { domain: 'www.restorativefutures.co.uk', status: 'live' }, 'bemoreswan.site');
assert.strictEqual(rf.url, 'https://www.restorativefutures.co.uk', 'a live own domain is the address shown');
assert.strictEqual(rf.hostedUrl, 'https://restorative-futures.bemoreswan.site', 'the bemoreswan.site address is kept as the second line');

// A domain still connecting: the site is still served at bemoreswan.site, and the domain is shown as connecting.
const pending = siteAddresses('acme', { domain: 'acme.co.uk', status: 'pending_dns' }, 'bemoreswan.site');
assert.strictEqual(pending.url, 'https://acme.bemoreswan.site');
assert.deepStrictEqual(pending.ownDomain, { domain: 'acme.co.uk', status: 'pending_dns' });

// No domain, or a removed one: just the bemoreswan.site address.
assert.strictEqual(siteAddresses('plain', null, 'bemoreswan.site').url, 'https://plain.bemoreswan.site');
assert.strictEqual(siteAddresses('gone', { domain: 'gone.com', status: 'removed' }, 'bemoreswan.site').ownDomain, null);

// The admin endpoint reads site_domains and uses the rule; the page shows the second line.
const fn = readFileSync(join(__dirname, '..', 'netlify/functions/admin-sites.ts'), 'utf8');
assert.ok(fn.includes('...siteAddresses(r.slug, domains.find((d) => d.siteId === r.id) ?? null)'), 'admin-sites uses the own domain');
assert.ok(fn.includes("ne(siteDomains.status, 'removed')"), 'removed domains are ignored');
const admin = readFileSync(join(__dirname, '..', 'admin.html'), 'utf8');
assert.ok(admin.includes('(redirects to its own domain)'), 'the bemoreswan.site address is still visible');

console.log('repro-issue-62: Hosted Sites shows a live own domain ✓');
