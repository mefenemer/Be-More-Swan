// tests/repro-issue-68.test.ts
// Fix pipeline #68 (prod, owner report, 2026-11-16; Blog Writer "Lyra", chat 163, msgs 1509–1510): asked "where are
// topics and themes", the assistant answered correctly in words but gave no button. Take Me There existed only on the
// Business Mentor's route: the prompt line came from mentorCardsPromptBlock() and the card was only built in the
// business_mentor branch, so every other assistant was never told about it, and its route's own card list would
// have dropped it. Owner, 2026-11-24: "Build Take Me There on every assistant's chat".
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tmt from '../src/config/take-me-there';

const lyra = { id: 6, name: 'Lyra' };
const team = [lyra, { id: 1, name: 'Marvin', job: 'Social Media Manager' }, { id: 31, name: 'Mentor', job: 'Business Mentor' }];

// 1. Every other assistant is told about the card, with its own id and the workspace's assistants.
const lineFor = (tmt as any).takeMeThereAssistantPromptLine;
assert.strictEqual(typeof lineFor, 'function', 'there is a Take Me There line for assistants other than the Mentor');
const line: string = lineFor(lyra, team);
assert.ok(line.includes('"type":"mentor_take_me_there"'), 'the card shape');
assert.ok(line.includes('yours is 6'), 'its own id, for a place on its own page');
assert.ok(line.includes('1 = Marvin (Social Media Manager)'), 'the other assistants, by id');
assert.ok(line.includes('"assistant_topics"'), 'Topics & themes is a place');

// 2. "Where are topics and themes" → a button that opens Lyra's "When and how I work" card.
const card = tmt.buildTakeMeThereCard({ place: 'assistant_topics', assistantId: 6, summary: 'Your topics, one row each.' }, team);
assert.ok(!('error' in card), 'a topics card is built');
if (!('error' in card)) {
    assert.strictEqual(card.assistantId, 6);
    assert.strictEqual(card.assistantTab, 'operation');
    assert.ok(card.label.startsWith("Lyra's Topics & themes"), card.label);
}
// Still a closed list: an unknown place or an assistant not on the workspace gets no card.
assert.ok('error' in tmt.buildTakeMeThereCard({ place: 'somewhere_else' }, team));
assert.ok('error' in tmt.buildTakeMeThereCard({ place: 'assistant_topics', assistantId: 999 }, team));

// 3. The orchestrator gives the line to every structured route and keeps the card through each route's rebuild.
const orch = readFileSync(join(__dirname, '..', 'netlify/functions/chat-orchestrator.ts'), 'utf8');
assert.ok(orch.includes('offersOwnCards ? SUPPORT_REQUEST_PROMPT : null, takeMeThereBlock,'), 'the line is in every structured route\'s prompt');
assert.ok(orch.includes("if (offersOwnCards && (uiElement as { type?: unknown } | null)?.type === 'mentor_take_me_there') {"), 'the card is checked on those routes');
assert.ok(orch.includes('const card = buildTakeMeThereCard(uiElement as Record<string, unknown>, takeMeThereTeam);'), 'against the same closed list');
assert.ok(orch.includes('if (takeMeThereCard) uiElement = takeMeThereCard;'), 'and put back after the route rebuilds its own card');

console.log('repro-issue-68: Take Me There on every assistant\'s chat ✓');
