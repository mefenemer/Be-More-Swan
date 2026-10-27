// tests/lead-person.test.ts
// The one-pass contact search (docs/lead-search-one-pass-plan.md): the pure rules that decide WHO a
// lead is addressed to and whether an address we hold is theirs, the Companies House match, Hunter's
// Email Finder parsing, the order of the waterfall, and erasure reaching every field it writes.

process.env.DISCOVERY_ENRICH_PROVIDER = 'hunter';
process.env.HUNTER_API_KEY = 'test-key';

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
// Checks run ONE AT A TIME: the Hunter checks swap globalThis.fetch, and two at once would read
// each other's fake response.
let chain: Promise<void> = Promise.resolve();
const check = (name: string, fn: () => void | Promise<void>) => {
    chain = chain.then(async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
    });
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

async function main() {
const person = await import('../src/config/lead-person');
const ch = await import('../src/lib/companies-house');
const scrape = await import('../src/lib/discovery-enrich');
const provider = await import('../src/lib/discovery-enrich-provider');

console.log('\n(1) Who the lead is addressed to\n');

check('a director named on their own site AND on the register wins', () => {
    const p = person.pickLeadPerson({
        site: [{ name: 'Sam Lee', title: 'Designer', sourceUrl: 'https://a.co.uk/team' },
               { name: 'Debbie Jones', title: 'Founder', sourceUrl: 'https://a.co.uk/about' }],
        officers: [{ name: 'Debbie Ann Jones', role: 'Director' }, { name: 'Tom Jones', role: 'Director' }],
        hunter: [],
    });
    assert.strictEqual(p?.name, 'Debbie Jones');
    assert.strictEqual(p?.source, 'website');
});

check('the sole active director is used when the site names nobody', () => {
    const p = person.pickLeadPerson({ site: [], officers: [{ name: 'Jane Smith', role: 'Director' }], officersUrl: 'https://ch/1', hunter: [] });
    assert.strictEqual(p?.name, 'Jane Smith');
    assert.strictEqual(p?.source, 'companies_house');
    assert.strictEqual(p?.sourceUrl, 'https://ch/1');
});

check('several directors and nothing to tell them apart → nobody (never a guess)', () => {
    const p = person.pickLeadPerson({ site: [], officers: [{ name: 'Jane Smith', role: 'Director' }, { name: 'Raj Patel', role: 'Director' }], hunter: [] });
    assert.strictEqual(p, null);
});

check('a site person with no decision-making title does not outrank the register', () => {
    const p = person.pickLeadPerson({
        site: [{ name: 'Amy Brown', title: 'Barista', sourceUrl: 'u' }],
        officers: [{ name: 'Jane Smith', role: 'Director' }], hunter: [],
    });
    assert.strictEqual(p?.name, 'Jane Smith');
});

check('a published address is matched to the person; a role inbox never is', () => {
    const emails = [
        { email: 'info@a.co.uk', kind: 'role', foundOn: 'x' },
        { email: 'debbie@a.co.uk', kind: 'personal', foundOn: 'y' },
    ];
    assert.strictEqual(person.matchPersonEmail({ name: 'Debbie Jones' }, emails)?.email, 'debbie@a.co.uk');
    assert.strictEqual(person.matchPersonEmail({ name: 'Info Desk' }, emails), null);
    assert.strictEqual(person.matchPersonEmail({ name: 'Sam Lee' }, emails), null, 'someone else\'s address was attributed to Sam');
    assert.strictEqual(person.matchPersonEmail({ name: 'Debbie Jones' }, [{ email: 'd.jones@a.co.uk', kind: 'personal' }])?.email, 'd.jones@a.co.uk');
});

check('middle names and accents do not split one person in two', () => {
    assert.ok(person.samePerson('Zoë Ann O’Neil', 'zoe oneil'));
    assert.ok(!person.samePerson('Jane Smith', 'Jane Smithson'));
});

console.log('\n(2) Companies House: a match must be unambiguous\n');

check('names compare without Ltd / punctuation / taglines', () => {
    assert.strictEqual(ch.normaliseCompanyName('Debonair Candles Ltd.'), 'debonair candles');
    assert.strictEqual(ch.normaliseCompanyName('DEBONAIR CANDLES LIMITED'), 'debonair candles');
    assert.strictEqual(ch.companyNameForLookup('Debonair Candles | Hand-poured soy candles'), 'Debonair Candles');
    assert.strictEqual(ch.companyNameForLookup('Smith-Jones Builders - Norwich'), 'Smith-Jones Builders');
});

check('register names read the way a person writes them', () => {
    assert.strictEqual(ch.officerNaturalName('SMITH, Jane Ann'), 'Jane Ann Smith');
    assert.strictEqual(ch.officerNaturalName("O'NEIL, Mrs Zoe"), "Zoe O'Neil");
});

const items = [
    { number: '01234567', name: 'BLOOM FLORISTS LTD', status: 'active', postcode: 'NR1 3QX' },
    { number: '07654321', name: 'BLOOM FLORISTS LIMITED', status: 'active', postcode: 'LS1 4AB' },
    { number: '09999999', name: 'BLOOM FLORISTS (NORWICH) LTD', status: 'active', postcode: 'NR2 1AA' },
];
check('two same-name companies: only the one whose postcode the site prints is used', () => {
    assert.strictEqual(ch.chooseCompany('Bloom Florists', items, ['NR13QX'])?.number, '01234567');
    assert.strictEqual(ch.chooseCompany('Bloom Florists', items, [])?.number, undefined, 'picked one of two namesakes with no evidence');
});
check('a single active namesake is used; a dissolved one never is', () => {
    const one = [{ number: '01111111', name: 'Debonair Candles Ltd', status: 'active', postcode: null }];
    assert.strictEqual(ch.chooseCompany('Debonair Candles', one, [])?.matchedBy, 'only_active_match');
    assert.strictEqual(ch.chooseCompany('Debonair Candles', [{ ...one[0], status: 'dissolved' }], []), null);
});
check('postcodes are read off the page and normalised', () => {
    const pcs = scrape.extractPostcodes('<footer>Unit 4, Norwich nr13qx · <script>var x="SW1A 1AA"</script></footer>');
    assert.deepStrictEqual(pcs, ['NR1 3QX']);
});

console.log('\n(3) Hunter Email Finder\n');

const realFetch = globalThis.fetch;
const fakeFetch = (body: unknown, status = 200) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
};
check('an address on the lead\'s domain is a hit, classified by OUR rule', async () => {
    fakeFetch({ data: { email: 'Debbie@a.co.uk', score: 91 } });
    const r = await provider.findPersonEmail('a.co.uk', { first: 'debbie', last: 'jones' });
    globalThis.fetch = realFetch;
    assert.strictEqual(r.status, 'hit');
    if (r.status === 'hit') { assert.strictEqual(r.contact.email, 'debbie@a.co.uk'); assert.strictEqual(r.contact.kind, 'personal'); }
});
check('no address, or one on another domain, is a miss', async () => {
    fakeFetch({ data: { email: null } });
    assert.strictEqual((await provider.findPersonEmail('a.co.uk', { first: 'a', last: 'b' })).status, 'miss');
    fakeFetch({ data: { email: 'debbie@gmail.com' } });
    assert.strictEqual((await provider.findPersonEmail('a.co.uk', { first: 'a', last: 'b' })).status, 'miss');
    globalThis.fetch = realFetch;
});
check('a refused call is an ERROR, never a miss', async () => {
    fakeFetch({ errors: [] }, 429);
    const r = await provider.findPersonEmail('a.co.uk', { first: 'a', last: 'b' });
    globalThis.fetch = realFetch;
    assert.deepStrictEqual(r, { status: 'error', reason: 'http_429' });
});

console.log('\n(4) The waterfall order: free first, Hunter LAST\n');

const enrichment = read('../src/utils/lead-enrichment.ts');
const waterfall = enrichment.slice(landmark(enrichment, 'export async function runContactWaterfall('), landmark(enrichment, 'export function worthFindingAddressFor('));
check('website → Companies House → Email Finder → Domain Search', () => {
    const at = (s: string) => { const i = waterfall.indexOf(s); assert.ok(i >= 0, `${s} missing from runContactWaterfall`); return i; };
    const order = [at('await enrichLeadContact('), at('await lookupCompaniesHouse('), at('await findPersonEmail('), at('await lookupProviderContact(')];
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'the steps run out of order');
});
check('Domain Search runs only when no address was found at all', () => {
    assert.ok(/if \(paid && !found\.contact\) \{\s*try \{\s*const outcome = await lookupProviderContact\(/.test(waterfall),
        'the last-resort lookup is no longer gated on having no address');
});
check('the worker and the button both use the waterfall', () => {
    assert.ok(read('../netlify/functions/process-discovery-jobs.ts').includes('await runContactWaterfall({'));
    assert.ok(enrichment.slice(landmark(enrichment, 'export async function enrichOneLead(')).includes('await runContactWaterfall({'));
});

console.log('\n(5) Erasure reaches everything the search writes\n');

check('every named-contact record key is in the erasure list', () => {
    const erasure = read('../src/utils/prospect-erasure.ts');
    const list = erasure.slice(landmark(erasure, 'const PERSONAL_RECORD_KEYS = ['), landmark(erasure, 'const COMPANY_RECORD_KEYS'));
    const keys = [...enrichment.slice(landmark(enrichment, 'export const NAMED_CONTACT_RECORD_KEYS = ['), landmark(enrichment, '] as const;')).matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    assert.ok(keys.length >= 8, 'could not read NAMED_CONTACT_RECORD_KEYS');
    const missing = keys.filter((k) => !list.includes(`'${k}'`));
    assert.deepStrictEqual(missing, [], 'erasing a prospect would leave these fields behind');
});
check('an erased lead is never researched again', () => {
    const erasure = read('../src/utils/prospect-erasure.ts');
    assert.ok(/'researchedAt'/.test(erasure), 'erasure no longer stamps researchedAt — the research pass would re-collect the person');
    assert.ok(/- 'person' - 'companiesHouse'/.test(erasure), 'erasure no longer strips the named-contact signals');
    const worker = read('../netlify/functions/process-discovery-jobs.ts');
    assert.ok(/COALESCE\(ar\.data ->> 'erasedAt', ''\) = ''/.test(worker), 'the research pass no longer skips erased records');
});

await chain;
console.log(`\n${passed} checks passed.\n`);
}
void main();
