// tests/offer-profile.test.ts
// "What does your business offer?" — Business Information shows booking and food fields only to the
// businesses that need them (owner, 2026-10-20: a SaaS was asked for allergens and a deposit).
// Run:  npx tsx tests/offer-profile.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { cleanOffers, describeOfferProfile, inferOffers, OFFER_KINDS } from '../src/utils/offer-profile';
import { SITE_FEATURES } from '../src/utils/site-definition';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('the kinds use the website\'s own words for the same things', () => {
    for (const k of OFFER_KINDS) assert.ok((SITE_FEATURES as readonly string[]).includes(k), k);
});

check('a software business with no clues gets neither', () => {
    assert.deepStrictEqual(inferOffers({ industry: 'SaaS & Software' }), []);
    assert.deepStrictEqual(inferOffers({}), []);
});

check('the guess follows what the business already did, then its industry', () => {
    assert.deepStrictEqual(inferOffers({ siteFeatures: ['shop', 'menu'] }), ['menu']);
    assert.deepStrictEqual(inferOffers({ hasDietary: true }), ['menu']);
    assert.deepStrictEqual(inferOffers({ hasBookingData: true }), ['bookings']);
    assert.deepStrictEqual(inferOffers({ industry: 'Beauty & Wellness' }), ['bookings']);
    assert.deepStrictEqual(inferOffers({ industry: 'Food & Beverage' }), ['menu']);
    assert.deepStrictEqual(inferOffers({ industry: 'Hospitality' }), ['bookings', 'menu']);
    // "bar" must be a word, not "barrister"
    assert.deepStrictEqual(inferOffers({ industry: 'Barristers' }), []);
});

check('only known kinds are saved; anything else is refused', () => {
    assert.deepStrictEqual(cleanOffers(['menu', 'shop', 'bookings']), ['bookings', 'menu']);
    assert.deepStrictEqual(cleanOffers([]), []);
    assert.strictEqual(cleanOffers('menu'), null);
});

check('assistants are told what is NOT offered — firmly only when it is the owner\'s answer', () => {
    const answered = describeOfferProfile({ offers: [], answered: true });
    assert.ok(answered.includes('their answer') && answered.includes("don't ask about or suggest those"));
    const guessed = describeOfferProfile({ offers: ['menu'], answered: false });
    assert.ok(guessed.includes('a guess') && guessed.includes('check with the user'));
});

check('every assistant gets the line, but only the owner\'s answer — never a guess', () => {
    const src = read('src/utils/org-products.ts');
    assert.ok(src.includes('loadAnsweredOffer(db, organisationId)') && !src.includes('loadOfferProfile('));
});

check('the form HIDES a group, never removes it — so saving cannot clear a value', () => {
    const html = read('assets.html');
    assert.ok(html.includes('data-op-group="menu"') && html.includes('data-op-group="bookings"'));
    assert.ok(html.includes("f.querySelector('[data-op-group=\"menu\"]').classList.toggle('hidden', !menu)"));
    // A value already there keeps its group visible.
    assert.ok(html.includes("!!val('op-allergens')") && html.includes("!!val('op-deposit-type')"));
    assert.ok(html.includes('data-bh-bookings') && html.includes("'Save hours & location'"));
});

check('GUI and chat save through ONE path', () => {
    assert.ok(read('netlify/functions/org-products.ts').includes('saveOfferProfile(db, orgId, offers'));
    assert.ok(read('assets.html').includes("call('PATCH', { offer: ticked })"));
    const chat = read('src/components/chat-session.js');
    assert.ok(chat.includes("addEventListener('site:offerProfile', onOfferProfile)") && chat.includes("body: JSON.stringify({ offer:"));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('offer_profile', renderOfferProfileCard)"));
    const prompt = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(prompt.includes('{"type":"offer_profile"') && prompt.includes('Never emit one from your own guess'));
    assert.ok(read('src/utils/site-store.ts').includes('describeOfferProfile(await loadOfferProfile(db, orgId))'));
});

check('reads survive the table not being applied yet', () => {
    const src = read('src/utils/offer-profile.ts');
    const fn = src.slice(src.indexOf('export async function loadAnsweredOffer'), src.indexOf('export async function loadOfferProfile'));
    assert.ok(fn.includes('catch') && fn.includes('return null'));
});

console.log(`\n${passed} passed, 0 failed\n`);
