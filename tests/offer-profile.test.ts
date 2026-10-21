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

check('where the website has the same idea, it uses the same word', () => {
    for (const k of ['bookings', 'menu'] as const) assert.ok((SITE_FEATURES as readonly string[]).includes(k), k);
    // shop ↔ products and hours ↔ visits are mapped in inferOffers.
    assert.deepStrictEqual(inferOffers({ siteFeatures: ['shop', 'hours'] }), ['products', 'visits']);
});

check('a software business is guessed as software, not as a café', () => {
    assert.deepStrictEqual(inferOffers({ industry: 'SaaS & Software' }), ['subscriptions']);
    assert.deepStrictEqual(inferOffers({}), []);
});

check('the guess follows what the business already did, then its industry', () => {
    assert.deepStrictEqual(inferOffers({ siteFeatures: ['shop', 'menu', 'hours'] }), ['products', 'visits', 'menu']);
    assert.deepStrictEqual(inferOffers({ hasDietary: true }), ['menu']);
    assert.deepStrictEqual(inferOffers({ hasBookingData: true, hasVisitAddress: true }), ['bookings', 'visits']);
    assert.deepStrictEqual(inferOffers({ hasServices: true, hasRecurringPrice: true }), ['services', 'subscriptions']);
    assert.deepStrictEqual(inferOffers({ industry: 'Consulting' }), ['services']);
    assert.deepStrictEqual(inferOffers({ industry: 'Retail' }), ['products', 'visits']);
    assert.deepStrictEqual(inferOffers({ industry: 'Food & Beverage' }), ['menu']);
    // "bar" must be a word, not "barrister"
    assert.deepStrictEqual(inferOffers({ industry: 'Barristers' }), []);
});

check('only known kinds are saved; anything else is refused', () => {
    assert.deepStrictEqual(cleanOffers(['menu', 'shop', 'bookings', 'asked:6', 'services']), ['services', 'bookings', 'menu']);
    assert.deepStrictEqual(cleanOffers([]), []);
    assert.strictEqual(cleanOffers('menu'), null);
});

check('an answer to the OLD two-box question is not read as "sells nothing"', () => {
    const src = read('src/utils/offer-profile.ts');
    assert.ok(src.includes("const ASKED_ALL = 'asked:6'") && src.includes('const stored = [...offers, ASKED_ALL]'));
    // Only a complete answer reaches every assistant.
    assert.ok(src.includes('return r.complete ? { offers: r.offers, answered: true } : null;'));
});

check('assistants are told what is NOT ticked — firmly only when it is the owner\'s answer', () => {
    const answered = describeOfferProfile({ offers: ['services'], answered: true });
    assert.ok(answered.includes('their answer') && answered.includes("don't assume or suggest those") && answered.includes('we sell products'));
    const guessed = describeOfferProfile({ offers: ['menu'], answered: false });
    assert.ok(guessed.includes('a guess') && guessed.includes('check with the user'));
});

check('every tick changes something real', () => {
    const html = read('assets.html');
    for (const k of OFFER_KINDS) assert.ok(html.includes(`data-op-offer value="${k}"`), k);
    assert.ok(html.includes("kind: offers('services') && !offers('products') ? 'service' : 'product'"));
    assert.ok(html.includes("offers('subscriptions') ? { priceType: 'fixed', priceUnit: 'a month' }"));
    assert.ok(html.includes("tab('bookings')?.classList.toggle('hidden', !books)"));
    assert.ok(html.includes("const hours = books || o.offers.includes('visits')"));
    // The chat card and the prompt name the same six.
    const card = read('src/components/disruptive-ui-registry.js');
    for (const k of OFFER_KINDS) assert.ok(card.includes(`${k}: '`), `card ${k}`);
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
    assert.ok(html.includes('data-panel="bookings"') && html.includes('Save hours &amp; location'));
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
