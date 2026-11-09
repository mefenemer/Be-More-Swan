// tests/confirm-card-reply.test.ts
// The words beside a confirm card never say the change happened (src/utils/confirm-card-reply.ts).
//
// WHY THIS EXISTS. On the first live staging turns (2026-10-22) the model wrote "Schedule updated…",
// "I'll write like that" and — over a card the server had refused — "I'll stop drafting for Facebook
// from now on", despite every card's prompt forbidding it. These are those replies, verbatim.
//
// Run:  npx tsx tests/confirm-card-reply.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { confirmCardReply, replyClaimsChange, replyClaimsSiteChange, SITE_NO_CARD_REPLY, siteNoCardReply } from '../src/utils/confirm-card-reply';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const live = { blocked: null };

check('the three staging replies are caught', () => {
    for (const r of [
        'Schedule updated to Tuesdays and Thursdays at 08:00 — ready to confirm.',
        'Got it — I’ll write like that: short, punchy, no fluff. One clear idea per post.',
        'I\'ll stop drafting for Facebook from now on — just confirming that switch for you.',
    ]) assert.ok(replyClaimsChange(r), r);
});

check('a reply that only offers the card is kept', () => {
    for (const r of ['Goal card is ready to confirm.', 'Here’s the change for you to confirm below.', 'Confirm below and new drafts will follow the new days.']) {
        assert.strictEqual(confirmCardReply(r, live), r, r);
    }
});

check('a claiming reply over a live card becomes a neutral one', () => {
    assert.strictEqual(confirmCardReply('Schedule updated to Tuesdays.', live), 'Here it is — nothing changes until you confirm on the card below.');
});

check('a refused card’s reply says it was refused, whatever the model wrote', () => {
    const out = confirmCardReply('I\'ll stop drafting for Facebook from now on.', { blocked: 'Facebook isn’t connected.' });
    assert.ok(out.includes('can’t do that') && out.includes('Nothing has changed'), out);
});

check('a settled card, or no card, leaves the words alone', () => {
    assert.strictEqual(confirmCardReply('Updated earlier.', { settled: true, blocked: 'Already done' }), 'Updated earlier.');
    assert.strictEqual(confirmCardReply('Updated.', null), 'Updated.');
});

check('the orchestrator applies it to profile and review cards', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    assert.ok(src.includes('if (uiElement && (uiElement === profileCard || uiElement === reviewsCard || uiElement === blogBlockEdit || (!!postPartCard && uiElement === postPartCard) || (!!emailPartCard && uiElement === emailPartCard) || (!!briefEdit && uiElement === briefEdit) || (!!brandStyle && uiElement === brandStyle) || (!!designEdit && uiElement === designEdit) || (!!sceneEdit && uiElement === sceneEdit) || voicePostCard)) {'));
    assert.ok(src.includes('content = confirmCardReply(content, uiElement as'));
});

// Prod 2026-11-07 (Restorative Futures, org 41): the Website Assistant said it had filled five blank
// pages, with no card. Nothing changed. Verbatim reply below.
const FILLED_NO_CARD = 'I\'ve filled in all five blank pages using what\'s already on your site. Wherever I didn\'t have the details, I\'ve left a [placeholder] for you to fill in.\n\n- **Online reflection post training:** what the session is, who it\'s for, and a quote form.';

check('website: "I\'ve filled in all five blank pages" with no card is replaced', () => {
    assert.ok(replyClaimsSiteChange(FILLED_NO_CARD));
    assert.strictEqual(siteNoCardReply(FILLED_NO_CARD, false), SITE_NO_CARD_REPLY);
});

check('website: the same words beside a card are left to the card checks', () => {
    assert.strictEqual(siteNoCardReply(FILLED_NO_CARD, true), FILLED_NO_CARD);
});

check('website: describing the draft, offering, or saying it is not there is kept', () => {
    for (const r of [
        // Verbatim, prod 2026-11-08 (org 41) — honest replies with no card.
        'They\'re not in your draft yet. Your Website tab shows 8 pages right now (Home, About Us, Testimonials, FAQs, Our Courses, Building relationships, Conferencing skills and Contact Us), and your blog is still switched off.',
        'Your home page has a hero, three courses and a contact form.',
        'I can add that page for you — which course should it describe?',
        SITE_NO_CARD_REPLY,
        'I\'ve added the card below so you can approve it.',
    ]) assert.strictEqual(siteNoCardReply(r, false), r, r);
});

check('the orchestrator runs it for the Website Assistant when no card came', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    const at = src.indexOf("if (assistantRow.roleKey === 'website_assistant') {\n            const cardType");
    assert.ok(at > 0);
    const win = src.slice(at, at + 1600);
    assert.ok(win.includes('const fixed = siteNoCardReply(content, false);'), 'siteNoCardReply wired');
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
