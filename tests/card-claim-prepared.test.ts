// Minute Taker run B (staging 2026-11-17): the reply claimed a card that was never drawn, in words the
// "points at a card" check did not know, so no note was added and the raw reply was not kept.
// Run: npx tsx tests/card-claim-prepared.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { missingCardReply, NO_CARD_NOTE, replyPointsAtCard } from '../src/utils/confirm-card-reply';

const verbatim = "I've prepared a card to add bmsreview.test+cara@gmail.com as Cara Singh's email address on meeting #920. Nothing changes until you confirm it on the card. Once it's saved, the follow-up can go to her with the rest of the attendees when you approve the meeting.";
assert.ok(replyPointsAtCard(verbatim));
assert.strictEqual(missingCardReply(verbatim, false), `${verbatim}\n\n${NO_CARD_NOTE}`);
assert.strictEqual(missingCardReply(verbatim, true), verbatim, 'with the card there, untouched');
for (const r of ["I've created a card for that change.", 'Confirm on the card to save it; nothing changes until you do.', 'I have set up a card to approve the meeting.']) {
    assert.ok(replyPointsAtCard(r), r);
}
// Offers are still not claims.
for (const r of ["Tell me the address and I'll put it on a card for you to confirm.", 'Want me to prepare a card for that?']) {
    assert.ok(!replyPointsAtCard(r), r);
}
// An unreadable reply keeps its raw text as a hidden row too.
const orch = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
assert.ok(orch.includes('if (!droppedCard && content === STRUCTURED_REPLY_FALLBACK) {'));
console.log('card-claim-prepared: all checks passed');
