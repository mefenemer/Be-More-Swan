// tests/intro-offer.test.ts
// "Do you offer a free trial or an introductory offer?" — one workspace answer on Business
// Information ▸ Products & Services that every assistant uses (owner, 2026-10-24).
// Run:  npx tsx tests/intro-offer.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    cleanIntroOffer, describeIntroOffer, introOfferCardFromUiElement, introOfferFact, introOfferPromptBlock,
    introOfferQuestion, introOfferShortLine, INTRO_OFFER_KINDS, INTRO_OFFER_LABELS, suggestedIntroKinds, summariseIntroOffer,
    type IntroOffer,
} from '../src/utils/intro-offer';
import { composeDeclaredFacts } from '../src/utils/post-quality-review';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ok = (v: unknown) => { const r = cleanIntroOffer(v); assert.ok('offer' in r, JSON.stringify(r)); return (r as { offer: IntroOffer }).offer; };
const err = (v: unknown) => { const r = cleanIntroOffer(v); assert.ok('error' in r, JSON.stringify(r)); return (r as { error: string }).error; };

check('"no" is a real answer, distinct from not answering', () => {
    assert.deepStrictEqual(ok({ has: false, kind: 'free_trial', days: 14 }), { has: false });
    err(null); err({}); err({ has: 'yes' });
});

check('a free trial needs its length; card and what happens after are kept', () => {
    assert.match(err({ has: true, kind: 'free_trial' }), /how many days/);
    err({ has: true, kind: 'free_trial', days: 0 });
    err({ has: true, kind: 'free_trial', days: 400 });
    err({ has: true, kind: 'free_trial', days: 7.5 });
    const o = ok({ has: true, kind: 'free_trial', days: '14', cardUpFront: false, afterwards: 'stops', terms: '  full access  ' });
    assert.ok(o.has && o.days === 14 && o.cardUpFront === false && o.afterwards === 'stops' && o.terms === 'full access');
});

check('fields that do not fit the kind are dropped, not stored', () => {
    const o = ok({ has: true, kind: 'free_consultation', days: 30, cardUpFront: true, afterwards: 'auto_charge' });
    assert.ok(o.has && o.days === null && o.cardUpFront === null && o.afterwards === null);
    assert.ok(!('error' in cleanIntroOffer({ has: true, kind: 'money_back', days: 30 })));
});

check('a discount or "something else" must say what the deal is', () => {
    for (const kind of ['freemium', 'first_visit', 'intro_discount', 'other']) assert.match(err({ has: true, kind }), /Describe the offer/);
    err({ has: true, kind: 'nonsense', terms: 'x' });
});

check('a link is made a proper web address, and junk is refused', () => {
    const o = ok({ has: true, kind: 'free_consultation', url: 'example.com/book' });
    assert.ok(o.has && o.url === 'https://example.com/book');
    err({ has: true, kind: 'free_consultation', url: 'http://' });
});

check('the question and the order of kinds follow what the business offers', () => {
    assert.strictEqual(introOfferQuestion(['subscriptions']), 'Do you offer a free trial?');
    assert.match(introOfferQuestion(['services']), /consultation/);
    assert.match(introOfferQuestion([]), /free trial or an introductory offer/);
    assert.strictEqual(suggestedIntroKinds(['subscriptions'])[0], 'free_trial');
    assert.strictEqual(suggestedIntroKinds(['services'])[0], 'free_consultation');
    assert.strictEqual(suggestedIntroKinds(['bookings'])[0], 'first_visit');
    assert.strictEqual(suggestedIntroKinds(['menu'])[0], 'free_sample');
    // Every kind is always available, once.
    for (const offers of [[], ['subscriptions', 'services', 'menu']] as const) {
        const list = suggestedIntroKinds(offers as never);
        assert.deepStrictEqual([...list].sort(), [...INTRO_OFFER_KINDS].sort());
    }
});

check('every assistant is told all three states — and never to invent one', () => {
    const none = describeIntroOffer(null);
    assert.ok(none.includes('not recorded yet') && none.includes('Never promise a free trial'));
    const no = describeIntroOffer({ has: false });
    assert.ok(no.includes('do NOT offer') && no.includes('Never offer, suggest or hint'));
    const trial = ok({ has: true, kind: 'free_trial', days: 14, cardUpFront: false, afterwards: 'stops', whoFor: 'new customers only', url: 'https://x.test/start' });
    const yes = describeIntroOffer(trial);
    assert.ok(yes.includes('A free 14-day trial, no card needed up front') && yes.includes('it simply stops'));
    assert.ok(yes.includes('Who can have it: new customers only.') && yes.includes('Where to start: https://x.test/start'));
    assert.ok(yes.includes('never change the length') && yes.includes('never offer any other trial'));
    // The assistant's own brief still counts in the two "don't" states.
    for (const s of [none, no]) assert.ok(s.includes("this assistant's own brief"));
});

check('the short form and the reviewer fact say nothing until answered', () => {
    assert.strictEqual(introOfferShortLine(null), '');
    assert.strictEqual(introOfferFact(null), '');
    assert.strictEqual(introOfferShortLine({ has: false }), 'No free trial or introductory offer.');
    assert.match(introOfferFact({ has: false }), /NONE/);
    const o = ok({ has: true, kind: 'money_back', days: 30 });
    assert.match(introOfferFact(o), /A 30-day money-back guarantee/);
    assert.ok(summariseIntroOffer(o as Extract<IntroOffer, { has: true }>).startsWith('A 30-day money-back guarantee.'));
});

check('the reviewer sees the offer as a declared fact, tagged where to change it', () => {
    const f = composeDeclaredFacts(null, '', introOfferFact({ has: false }));
    assert.ok(f.startsWith('[Edited in: Business Information ▸ Products & Services] Free trial / introductory offer: NONE'));
    // An empty catalogue with an offer still reads the old notes (the offer is not "the catalogue").
    const sections = { '6-onboarding': { content: { answers: { service_offerings: 'Old box £5' } } } };
    assert.ok(composeDeclaredFacts(sections, '', introOfferFact({ has: false })).includes('Old box £5'));
    assert.strictEqual(composeDeclaredFacts(null, ''), '');
    const prompt = read('src/utils/post-quality-review.ts');
    assert.ok(prompt.includes('▸ Free trial or introductory offer, or mark this warning') && prompt.includes('introOfferFact(await loadIntroOffer(db, owner.orgId))'));
});

check('every seam gets it through the ONE products loader', () => {
    const src = read('src/utils/org-products.ts');
    assert.ok(src.includes('loadIntroOffer(db, organisationId)') && src.includes('describeIntroOffer(intro)'));
    assert.ok(src.includes('introOfferShortLine(intro)'));
});

check('reads survive the table not being applied yet', () => {
    const src = read('src/utils/intro-offer.ts');
    const fn = src.slice(src.indexOf('export async function loadIntroOffer'), src.indexOf('export async function saveIntroOffer'));
    assert.ok(fn.includes('catch') && fn.includes('return null'));
    assert.ok(read('db/z-org-intro-offer.sql').includes('CREATE TABLE IF NOT EXISTS org_intro_offer'));
    assert.ok(read('db/schema.ts').includes('pgTable("org_intro_offer"'));
});

check('the chat card goes through the same gate, and only the click saves', () => {
    assert.strictEqual(introOfferCardFromUiElement({ type: 'goal_proposal' }), null);
    assert.ok('error' in (introOfferCardFromUiElement({ type: 'intro_offer', offer: { has: true, kind: 'free_trial' } }) as object));
    const card = introOfferCardFromUiElement({ type: 'intro_offer', summary: 'No trial', offer: { has: false } });
    assert.deepStrictEqual(card, { type: 'intro_offer', summary: 'No trial', offer: { has: false } });
    const block = introOfferPromptBlock();
    assert.ok(block.includes('{ "type": "intro_offer"') && block.includes('never your own guess') && block.includes('only that click saves it'));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('introOfferCardFromUiElement(uiElement)') && orch.includes('?? libraryCard ?? introOfferCard'));
    assert.ok(orch.includes('const introOfferCardBlock = offersOwnCards ? introOfferPromptBlock() : null;') && orch.includes('goalsCardBlock, introOfferCardBlock,'));
});

check('GUI and chat save through ONE path', () => {
    assert.ok(read('netlify/functions/org-products.ts').includes('saveIntroOffer(db, orgId, parsed.offer'));
    const html = read('assets.html');
    assert.ok(html.includes("call('PATCH', { introOffer: payload })") && html.includes('id="op-intro"'));
    assert.ok(html.includes("if (e.target.value === 'no') return saveIntro({ has: false });"));
    const chat = read('src/components/chat-session.js');
    assert.ok(chat.includes("addEventListener('intro:offer', onIntroOffer)") && chat.includes('JSON.stringify({ introOffer:'));
    assert.ok(chat.includes("removeEventListener('intro:offer', onIntroOffer)"));
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('intro_offer', renderIntroOfferCard)"));
    // The tab and the card use the module's own labels.
    for (const k of INTRO_OFFER_KINDS) {
        assert.ok(html.includes(`${k}: '${INTRO_OFFER_LABELS[k]}'`), `tab ${k}`);
        assert.ok(reg.includes(`${k}: '${INTRO_OFFER_LABELS[k]}'`), `card ${k}`);
    }
});

console.log(`\n${passed} passed`);
