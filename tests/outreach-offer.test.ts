// tests/outreach-offer.test.ts
// A Lead Generator's outreach OFFER (owner, 2026-10-24): a free gift, the intro offer, or just a
// question — permission-based first emails under 75 words with no link, the link in the first
// follow-up, and a sign-up through a gift's tracked link credited to the lead.
// Run:  npx tsx tests/outreach-offer.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    followUpLinkTarget, OUTREACH_FIRST_EMAIL_RULES, OUTREACH_OFFER_KINDS, OUTREACH_OFFER_LABELS, outreachFirstEmailBlock,
    outreachFollowUpBlock, withOfferLink, type ResolvedOutreachOffer,
} from '../src/config/outreach-offer';
import { offerChoiceFromContext, offerRefFromUrl, signOfferRef, verifyOfferRef } from '../src/utils/outreach-offer';
import { outreachOfferCardFrom, renderOutreachOfferChatBlock } from '../src/utils/chat-outreach-offer';
import { SEQUENCE_HALT_REASONS, SEQUENCE_HALT_REASON_LABELS } from '../src/config/outreach-sequences';
import { EVENT_TYPES } from '../src/config/revenue-events';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const GIFT: ResolvedOutreachOffer = { kind: 'gift', formId: 7, formName: 'Playbook', giftLabel: 'Campaign Playbook', linkable: true };
const INTRO: ResolvedOutreachOffer = { kind: 'intro_offer', summary: 'A free 14-day trial, no card needed up front.', url: 'https://x.test/start' };

check('every first email: short, problem first, no link, no call, ends on a question', () => {
    for (const s of ['Under 75 words', 'THEIR situation or problem', 'No links', 'Never ask for a call', 'ONE question']) {
        assert.ok(OUTREACH_FIRST_EMAIL_RULES.includes(s), s);
    }
    for (const o of [GIFT, INTRO, { kind: 'reply' } as const, null]) assert.ok(outreachFirstEmailBlock(o).startsWith(OUTREACH_FIRST_EMAIL_RULES));
});

check('the ask follows the offer — permission for a gift, the exact terms for an intro offer', () => {
    const g = outreachFirstEmailBlock(GIFT);
    assert.ok(g.includes('free "Campaign Playbook"') && g.includes('Mind if I send it over?') && g.includes('Do not include it or link to it'));
    const i = outreachFirstEmailBlock(INTRO);
    assert.ok(i.includes('A free 14-day trial, no card needed up front.') && i.includes('never change any of them') && i.includes('Do not include the link'));
    assert.ok(outreachFirstEmailBlock(null).includes('no offer'));
});

check('only the FIRST follow-up carries the link, and only when there is one to carry', () => {
    assert.strictEqual(followUpLinkTarget(GIFT, 1), 'gift');
    assert.strictEqual(followUpLinkTarget(GIFT, 2), null);
    assert.strictEqual(followUpLinkTarget({ ...GIFT, linkable: false } as ResolvedOutreachOffer, 1), null);
    assert.strictEqual(followUpLinkTarget(INTRO, 1), 'intro_offer');
    assert.strictEqual(followUpLinkTarget({ ...INTRO, url: null } as ResolvedOutreachOffer, 1), null);
    assert.strictEqual(followUpLinkTarget({ kind: 'reply' }, 1), null);
    const withLink = outreachFollowUpBlock(GIFT, true);
    assert.ok(withLink.includes('added automatically') && withLink.includes('NEVER write a web address'));
    assert.ok(outreachFollowUpBlock(GIFT, false).includes('Do not write any link'));
    assert.strictEqual(withOfferLink('Hi.\nHere it is:  \n', 'https://x.test/f/a?lt=1.x'), 'Hi.\nHere it is:\nhttps://x.test/f/a?lt=1.x');
    assert.strictEqual(withOfferLink('Hi.', null), 'Hi.');
});

check('every seam that writes an opener gets the first-email block', () => {
    const scoring = read('src/lib/discovery-scoring.ts');
    assert.strictEqual(scoring.split('${outreachFirstEmailBlock(sender.outreachOffer)}').length - 1, 2, 'discovery scoring + re-scoring');
    const lg = read('netlify/functions/lead-generation.ts');
    assert.ok(lg.includes('${outreachFirstEmailBlock(leadSender.outreachOffer)}'), 'manual scoring');
    assert.ok(lg.includes('${outreachFirstEmailBlock(sendSender.outreachOffer)}'), 'send-time');
    assert.ok(!lg.includes('Under 150 words'), 'the old length rule would contradict the new one');
});

check('the follow-up seam gets the follow-up block and appends the link in code', () => {
    const f = read('netlify/functions/process-sequence-sends.ts');
    assert.ok(f.includes('${outreachFollowUpBlock(sender.outreachOffer, withOfferLinkLine)}'));
    assert.ok(f.includes('followUpLinkTarget(sender.outreachOffer, position)') /* the plan is editable: the FIRST follow-up is position 1, whatever its step number */ && f.includes('offerLinkForThread(db, sender.outreachOffer, row.lead_thread_id)'));
    assert.ok(f.includes('draft = { ...draft, body: withOfferLink(draft.body, offerLink) };'));
    assert.ok(!f.includes('no links unless one already appears in the transcript'));
    // Every outreach prompt reads the offer through the one sender loader.
    assert.ok(read('src/utils/sender-identity.ts').includes('outreachOffer = await resolveOutreachOffer(db, organisationId, a?.ctx);'));
});

check('the link is signed with the conversation, and a forged or altered one credits nothing', () => {
    const ref = signOfferRef(42, 'k1');
    assert.match(ref, /^42\.[0-9a-f]{20}$/);
    assert.strictEqual(verifyOfferRef(ref, 'k1'), 42);
    assert.strictEqual(verifyOfferRef(ref, 'k2'), null);
    assert.strictEqual(verifyOfferRef(ref.replace(/^42/, '43'), 'k1'), null);
    assert.strictEqual(verifyOfferRef('42', 'k1'), null);
    assert.strictEqual(offerRefFromUrl(`https://bemoreswan.com/f/guide?lt=${ref}&utm=x`), ref);
    assert.strictEqual(offerRefFromUrl('not a url'), null);
    assert.strictEqual(offerRefFromUrl(null), null);
});

check('a sign-up through the link credits the lead and stops its follow-ups', () => {
    const pub = read('netlify/functions/audience-public.ts');
    const bind = pub.indexOf('await bindConversion(db, {');
    const credit = pub.indexOf('await creditOfferSignup(db, { organisationId: orgId, formId: form.id, contactId, pageUrl });');
    assert.ok(bind > 0 && credit > bind, 'after the campaign binding, before either opt-in branch');
    assert.ok(credit < pub.indexOf('if (!form.doubleOptIn) {', bind));
    const src = read('src/utils/outreach-offer.ts');
    assert.ok(src.includes("t.organisationId !== input.organisationId") && src.includes("haltEnrolment(db, e, 'signed_up')"));
    assert.ok((EVENT_TYPES as readonly string[]).includes('offer_signed_up'));
    assert.ok(read('src/config/lead-activity-events.ts').includes('offer_signed_up:'));
    assert.ok((SEQUENCE_HALT_REASONS as readonly string[]).includes('signed_up') && SEQUENCE_HALT_REASON_LABELS.signed_up);
    const sql = read('db/sequence-halt-signed-up.sql');
    for (const r of SEQUENCE_HALT_REASONS) assert.ok(sql.includes(`'${r}'`), `SQL lists ${r}`);
});

check('a blank answer is "reply" — how every email was written before offers', () => {
    assert.deepStrictEqual(offerChoiceFromContext({}), { kind: 'reply', formId: null });
    assert.deepStrictEqual(offerChoiceFromContext(null), { kind: 'reply', formId: null });
    assert.deepStrictEqual(offerChoiceFromContext({ outreachOffer: 'gift', outreachOfferFormId: '9' }), { kind: 'gift', formId: 9 });
    assert.deepStrictEqual(offerChoiceFromContext({ outreachOffer: 'nonsense' }), { kind: 'reply', formId: null });
});

check('the chat card is rebuilt against the real gift forms', () => {
    const forms = [{ id: 7, name: 'Playbook', giftLabel: 'Campaign Playbook', linkable: true }];
    assert.strictEqual(outreachOfferCardFrom({ type: 'goal_proposal' }, forms), null);
    assert.ok('error' in (outreachOfferCardFrom({ type: 'outreach_offer', offer: 'gift', formId: 99 }, forms) as object));
    assert.ok('error' in (outreachOfferCardFrom({ type: 'outreach_offer', offer: 'gift' }, []) as object));
    assert.ok('error' in (outreachOfferCardFrom({ type: 'outreach_offer', offer: 'free stuff' }, forms) as object));
    const card = outreachOfferCardFrom({ type: 'outreach_offer', offer: 'gift', formId: 7, summary: 'Use the playbook' }, forms);
    assert.deepStrictEqual(card, { type: 'outreach_offer', summary: 'Use the playbook', offer: 'gift', offerLabel: OUTREACH_OFFER_LABELS.gift, formId: 7, formName: 'Playbook', giftLabel: 'Campaign Playbook' });
    const block = renderOutreachOfferChatBlock('no offer', forms);
    assert.ok(block.includes('formId 7') && block.includes('{ "type": "outreach_offer"') && block.includes('never say it HAS changed'));
});

check('GUI and chat save through ONE action, and every surface names the same offers', () => {
    const lg = read('netlify/functions/lead-generation.ts');
    assert.ok(lg.includes("if (action === 'set_outreach_offer') {") && lg.includes('outreachOffer: kind, outreachOfferFormId: formId'));
    assert.ok(lg.includes('giftForms: await listGiftForms(db, orgId)'));
    const tab = read('assistants.js');
    assert.ok(tab.includes("action: 'set_outreach_offer', assistantId: window._currentAssistantId") && tab.includes('parts.push(_rqOutreachOfferHtml());'));
    const chat = read('src/components/chat-session.js');
    assert.ok(chat.includes("action: 'set_outreach_offer', assistantId") && chat.includes("addEventListener('lead:outreachOffer', onOutreachOffer)") && chat.includes("removeEventListener('lead:outreachOffer', onOutreachOffer)"));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('outreach_offer', renderOutreachOfferCard)"));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('buildOutreachOfferChatBlock(db, orgId, session.aiAssistantId)') && orch.includes('?? introOfferCard ?? outreachOfferCard'));
    const setup = read('src/public/assistant-onboarding-schemas.js');
    for (const k of OUTREACH_OFFER_KINDS) {
        assert.ok(tab.includes(`${k}: '${OUTREACH_OFFER_LABELS[k]}'`), `tab ${k}`);
        assert.ok(setup.includes(`{ value: '${k}'`), `setup ${k}`);
    }
    assert.ok(setup.includes("key: 'outreachOffer'"));
});

check('the reply composer can put the link in, and never sends it on its own', () => {
    const threads = read('netlify/functions/lead-threads.ts');
    assert.ok(threads.includes('offerLinkForThread(db, offer, thread.id,') && threads.includes('offerLink,'));
    const ui = read('src/components/assistant-lead-threads.js');
    assert.ok(ui.includes('data-lt-offer-link=') && ui.includes('state.replyDraft[t.id] = box.value;'));
    assert.ok(ui.includes('offerLink: data.offerLink || null') && ui.includes('offerLink: fresh.offerLink || null'));
});

console.log(`\n${passed} passed`);
