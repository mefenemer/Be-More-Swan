// tests/discovery-search-country.test.ts
// A search that names a country must be SEARCHED from that country.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// Customer report, 2026-10-18: a UK search returned US leads. Serper answers as US Google unless
// it is sent `gl`, and nothing in discovery sent one — the word "UK" in a query is a keyword, not
// a location, so US businesses that mention the UK (and US places sharing a UK name) ranked.
// src/lib/discovery-search-area.ts now reads the country from the search's own words and the
// worker sends it as `gl`.
//
// Run:  npx tsx tests/discovery-search-country.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSearchArea } from '../src/lib/discovery-search-area';
import { serperBody } from '../src/lib/discovery-search';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(join(root, 'netlify/functions/process-discovery-jobs.ts'), 'utf8');

const country = (...texts: Array<string | null | undefined>) => resolveSearchArea(texts)?.country ?? null;

console.log('\n──── reading the country from the search ────');

check('the reported case: a UK search resolves to gb', () => {
    assert.equal(country('Independent coffee shops in the UK with no loyalty app'), 'gb');
    assert.equal(country('Boutique gyms across the United Kingdom'), 'gb');
    assert.equal(country('Family-run hotels in Scotland'), 'gb');
});

check('a UK county or city with no country named still resolves to gb', () => {
    assert.equal(country('Primary schools in Kent'), 'gb');
    assert.equal(country('Dentists in Manchester'), 'gb');
});

check('a named country beats a UK place name ("Kent, Washington")', () => {
    // ⚠️ Without this the UK place list would pin a US search to the UK — the same bug, reversed.
    assert.equal(country('Restaurants in Kent, Washington, USA'), 'us');
    assert.equal(country('Breweries in Cambridge, Massachusetts, United States'), 'us');
});

check('Northern Ireland is the UK, not two countries', () => {
    assert.equal(country('Accountants in Belfast, Northern Ireland'), 'gb');
    assert.equal(country('Accountants in Dublin, Ireland'), 'ie');
});

check('two countries named → no country sent (pinning one would hide the other)', () => {
    assert.equal(country('Wedding venues in the UK and Ireland'), null);
});

check('nothing named → no country sent, so the search runs exactly as before', () => {
    assert.equal(country('SaaS companies hiring their first marketer'), null);
    assert.equal(country(''), null);
    assert.equal(country(null, undefined), null);
});

check('ordinary words and style adjectives never pin a country', () => {
    // Each of these would have pinned a search to the wrong country with a naive list.
    assert.equal(country('Shops selling reading glasses'), null, '"reading" is not Reading');
    assert.equal(country('Bath fitters with no website'), null, '"bath" is not Bath');
    assert.equal(country('Bakeries in New York'), null, '"New York" must not match York');
    assert.equal(country('American diners in London'), 'gb', 'a style is not a location');
    assert.equal(country('Software firms in South East Asia'), null, '"south east" is not the South East');
    assert.equal(country('Agencies that work with us on retainers'), null, 'lower-case "us" is a pronoun');
});

check('a territory sweep\'s approved area counts as part of the search', () => {
    assert.equal(country('Primary schools', 'South East England'), 'gb');
});

console.log('\n──── what is sent to Serper ────');

check('a country is sent as gl', () => {
    assert.equal(serperBody('plumbers', 10, 1, undefined, 'gb').gl, 'gb');
    assert.equal(serperBody('plumbers', 10, 1, undefined, 'GB').gl, 'gb', 'normalised to lower case');
});

check('no country → no gl key at all (byte-identical to the pre-fix request)', () => {
    assert.deepEqual(serperBody('plumbers', 10), { q: 'plumbers', num: 10 });
    assert.deepEqual(serperBody('plumbers', 10, 1, undefined, null), { q: 'plumbers', num: 10 });
});

check('a malformed country is dropped, never forwarded', () => {
    assert.equal('gl' in serperBody('plumbers', 10, 1, undefined, 'United Kingdom'), false);
    assert.equal('gl' in serperBody('plumbers', 10, 1, undefined, 'g'), false);
});

check('page and date restriction still travel alongside gl', () => {
    assert.deepEqual(serperBody('plumbers', 10, 2, 'qdr:m', 'gb'), { q: 'plumbers', num: 10, page: 2, tbs: 'qdr:m', gl: 'gb' });
});

console.log('\n──── the worker actually uses it ────');

check('the worker resolves the area from the idea and the territory plan', () => {
    assert.ok(/resolveSearchArea\(\[campaign\.idea, readTerritoryPlan\(campaign\.approvedBrief\)\?\.area\]\)/.test(WORKER),
        'the area must come from what the user approved — the idea and a sweep\'s area');
});

check('the discovery search call passes the country', () => {
    assert.ok(/await search\(query, \{[^}]*country: searchArea\?\.country/.test(WORKER),
        'without country on this call the whole fix is inert — Serper falls back to US Google');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}.`);
