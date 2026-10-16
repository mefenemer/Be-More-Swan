// tests/site-host-cache.test.ts
// One site's page must never be served at another site's address. The sites host fetches
// site-serve?path=… with the site in a header; a cache keyed on the URL alone would mix sites up
// (seen the day wildcard routing went live, 2026-10-16: one address's page served for www and others).
//
// Run:  npx tsx tests/site-host-cache.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };

check('every site-serve response varies by the site address', () => {
    const src = read('netlify/functions/site-serve.ts');
    assert.ok(src.includes("export const SITE_VARY = { 'Netlify-Vary': 'query, header=X-Site-Host', Vary: 'X-Site-Host' } as const;"), 'by address AND query string (path=, q=)');
    assert.ok(src.includes('return { ...res, headers: { ...(res.headers || {}), ...SITE_VARY } };'), 'applied to the handler\'s every return');
    assert.strictEqual((src.match(/export default withLambda\(/g) || []).length, 1);
});
check('the sites host puts the address in the URL it requests, too', () => {
    const edge = read('sites-host/edge-functions/serve.ts');
    assert.ok(edge.includes('/.netlify/functions/site-serve?host=${encodeURIComponent(url.host)}&path='));
    assert.ok(edge.includes("'x-site-host': url.host"));
});

console.log(`\n${passed}/2 passed\n`);
