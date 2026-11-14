// tests/repro-issue-58.test.ts
// Fix pipeline #58 (prod, workspace 40, Business Mentor chat 133, 2026-11-14): "A reply described a setup change
// card but the card did not appear." Three Mentor replies that afternoon ended in a bracketed "[Card: …]" line
// written as TEXT (the shape of the "[Card under this reply: …]" line the history shows under earlier cards):
//   1327 13:25 "What I can do is look it up: the card below runs a background search…" — read as an OFFER
//        (the "I can" before the colon), so no retry and no note.
//   1338 13:33 "The card below updates it…" — caught ([card-dropped] prose, not JSON), note added.
//   1340 13:35 "Here it is now, below this message." — matched nothing: no retry, no note.
// And the user saw the "[Card: …]" text itself, and quoted it back. Runs the REAL rules the orchestrator uses.
import assert from 'node:assert';
import { CARD_FORMAT_RETRY, missingCardReply, NO_CARD_NOTE, proseReplyLostItsCard, replyPointsAtCard } from '../src/utils/confirm-card-reply';

const r1327 = `I can't open Google Trends myself, so I can't read live search figures for you.

What I can do is look it up: the card below runs a background search with sources. It uses 1 task, takes about two minutes, and the answer comes back into this chat with links.

[Card: Look up when interest peaks in teachers deciding whether to retire and in life after retirement for women.]`;
const r1340 = `Sorry about that, Angela. The card didn't come through last time. Here it is now, below this message.

It updates the Blog Writing Assistant's "Topics & themes" to read:

> Retirement planning, Lifestyle medicine, Beyond the title

That's 196 characters, so it fits under the 200 limit. Nothing changes until you click.



[Card: Update the Blog Writing Assistant's topics to add "Retirement planning" first, with three topics shortened to fit the limit.]`;

for (const [id, text] of [['1327', r1327], ['1340', r1340]] as const) {
    assert.ok(replyPointsAtCard(text), `#${id} points at a card`);
    assert.ok(proseReplyLostItsCard(text, { content: text, uiElement: null }), `#${id} is asked again as JSON`);
    const shown = missingCardReply(text, false);
    assert.ok(!/\[\s*card\s*:/i.test(shown), `#${id}: the "[Card: …]" text is not shown`);
    assert.ok(shown.endsWith(NO_CARD_NOTE), `#${id}: the user is told no card came`);
}
// With a real card, the placeholder text still goes and no note is added.
const withCard = missingCardReply(r1340, true);
assert.ok(!withCard.includes('[Card:') && !withCard.includes(NO_CARD_NOTE));
// The retry names the shape it must not use.
assert.match(CARD_FORMAT_RETRY, /\[Card: …\]/);
// Offers still aren't claims.
assert.ok(!replyPointsAtCard("Tell me which one and I'll put it on a card that shows every word."));
assert.strictEqual(missingCardReply('Plain reply, no card talk.', false), 'Plain reply, no card talk.');
console.log('repro-issue-58: passed');
