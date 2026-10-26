// tests/mentor-rubric-fixes.test.ts
// Fixes from the Business Mentor's first rubric run on staging (2026-10-26, docs/business-mentor-rubric.md):
//   W8  no paid plan → the chat route paywalled the Mentor (403); §2.7 says it still answers, help-only
//   W6  "I've added a card that looks up…" over no card at all
//   W9  "Use the "Request a call back" button shown with this reply" — no such button was shown
//   W5  a whole launch plan written into chat took 26.5 s, over the 26 s limit

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingCardReply, NO_CARD_NOTE, replyPointsAtCard } from '../src/utils/confirm-card-reply';
import { MENTOR_CRAFT } from '../src/constants/mentor-craft';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const ORCH = read('netlify/functions/chat-orchestrator.ts');
const CREDIT = read('src/utils/task-credit.ts');

check('W8: a no-plan refusal says so, apart from fair use and failures', () => {
    assert.match(CREDIT, /if \(!hasPlan\) return \{ allowed: false, noPlan: true, limitMessage: NO_PLAN_MESSAGE \}/);
});

check('W8: only a Mentor turn passes the no-plan paywall, never a Team note, and still under fair use', () => {
    const gate = ORCH.slice(ORCH.indexOf('let mentorNoPlan = false;'), ORCH.indexOf('if (!capacity.allowed && !mentorNoPlan) {'));
    assert.ok(gate.length > 0 && gate.length < 1500, 'the exemption sits right before the paywall');
    assert.match(gate, /capacity\.noPlan/);
    assert.match(gate, /body\.teamMessageId === undefined/);
    assert.match(gate, /isMentorTurn\(db, orgId, body\)/);
    assert.match(gate, /checkFairUse\(db, orgId, 'chat'\)/);
    assert.match(ORCH, /console\.warn\(`\[chat-orchestrator\] paywall hit \(foreground\)/, 'everyone else still gets the paywall');
});

check('W8: help-only mode reads the Help Centre and draws nothing but the support card', () => {
    assert.match(ORCH, /const mentorNoPlanBlock = mentorNoPlan \?/);
    assert.match(ORCH, /loadHelpKnowledge\(db\)/);
    assert.match(ORCH, /myAccountBlock, mentorNoPlanBlock\]\.filter\(Boolean\)/);
    assert.match(ORCH, /if \(mentorNoPlan && \(uiElement as \{ type\?: unknown \} \| null\)\?\.type !== 'mentor_support_request'\) uiElement = null;/);
    assert.match(ORCH, /if \(!uiElement && !mentorNoPlan\) uiElement = cardTheUserAskedFor\(typed\);/);
    // The filter runs before any Mentor card is checked or recorded as a proposal.
    assert.ok(ORCH.indexOf("!== 'mentor_support_request') uiElement = null;") < ORCH.indexOf('recordMentorProposal(db, {'));
});

check('W6: the verbatim staging reply gets the note when no card came with it', () => {
    const w6 = 'I won’t quote the current figure from memory because it changes. I\'ve added a card that looks up the up-to-date rules with sources.';
    assert.ok(replyPointsAtCard(w6));
    assert.strictEqual(missingCardReply(w6, false), `${w6}\n\n${NO_CARD_NOTE}`);
    assert.strictEqual(missingCardReply(w6, true), w6, 'kept when the card is there');
    assert.strictEqual(missingCardReply(`${w6}\n\n${NO_CARD_NOTE}`, false), `${w6}\n\n${NO_CARD_NOTE}`, 'never twice');
});

check('W6: other staging phrasings are caught, ordinary replies are not', () => {
    for (const s of ['Below is a card that adds your three services.', 'Just tap an answer below.', 'Approve the card below and I’ll do the rest.']) {
        assert.ok(replyPointsAtCard(s), s);
    }
    for (const s of ['I can draft that list for you to approve.', 'Your Products & Services list is still empty.', 'A card game night could be a good event.',
        'I\'ve listed the three steps below.', 'Go to Business Information and remove the entries below:']) {
        assert.ok(!replyPointsAtCard(s), s);
    }
});

check('prod 2026-10-26: a reply that points at a change below without saying "card" is caught too', () => {
    for (const s of ['I\'ve put that change below for you to approve.', 'I’ve put it below.', 'Approve it below and Marvin uses it from his next post.',
        'The change below swaps his offer for the trial.', 'It’s below for you to confirm.']) {
        assert.ok(replyPointsAtCard(s), s);
    }
});

check('W6: the Mentor route applies the guard after the last card decision', () => {
    const at = ORCH.indexOf('const fixed = missingCardReply(content, !!uiElement);');
    assert.ok(at > 0);
    assert.ok(at > ORCH.indexOf('if (!uiElement && asksForACall(typed)) uiElement = callbackOfferElement();'));
    assert.match(ORCH, /if \(route === ROUTES\.business_mentor\) \{\s*const fixed = missingCardReply/);
});

check('W9: the shared rule only names the call-back button when it is really shown', () => {
    assert.match(ORCH, /Mention that button ONLY when they asked for a person or a call and your reply carries no other card/);
    // …which is exactly when the server draws it:
    assert.match(ORCH, /if \(!uiElement && asksForACall\(typed\)\) uiElement = callbackOfferElement\(\);/);
});

check('W5: a chat reply stays short, and a whole plan goes to the Plan tab', () => {
    assert.match(MENTOR_CRAFT, /under about 250 words/);
    assert.match(MENTOR_CRAFT, /strategy_proposal card with op "draft"/);
});

check('W5/W6: the Mentor\'s JSON reply format is restated at the very end of its system prompt', () => {
    assert.match(ORCH, /const system = route === ROUTES\.business_mentor \? `\$\{builtSystem\}\\n\\n\$\{MENTOR_REPLY_FORMAT_REMINDER\}` : builtSystem;/);
    assert.match(ORCH, /MENTOR_REPLY_FORMAT_REMINDER = 'REPLY FORMAT[^']*Never answer in plain prose/);
});

console.log(`\n${passed} passed`);
