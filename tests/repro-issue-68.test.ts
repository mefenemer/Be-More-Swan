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

// 4. Review on PR #839: "Topics & themes" opens the card that assistant really has, by its role.
const roles = [{ id: 6, name: 'Lyra', roleKey: 'blog_writer' }, { id: 1, name: 'Marvin', roleKey: 'social_media_manager' }, { id: 9, name: 'Nina', roleKey: 'lead_qualifier' }];
const forBlog = tmt.buildTakeMeThereCard({ place: 'assistant_topics', assistantId: 6 }, roles);
const forSocial = tmt.buildTakeMeThereCard({ place: 'assistant_topics', assistantId: 1 }, roles);
const forOther = tmt.buildTakeMeThereCard({ place: 'assistant_topics', assistantId: 9 }, roles);
assert.ok(!('error' in forBlog) && forBlog.place === 'assistant_topics' && forBlog.assistantTab === 'operation', 'Blog Writer: Topics & themes');
assert.ok(!('error' in forSocial) && forSocial.place === 'assistant_what_i_post_about' && forSocial.assistantTab === 'strategy', 'Social: What I post about');
assert.ok(!('error' in forSocial) && !forSocial.label.includes('Topics & themes'), 'and the label names what is there');
assert.ok(!('error' in forOther) && forOther.place === 'assistant_how_i_work', 'no topics at all: When and how I work');

// 4b. Review on PR #839 (second round): Blog Studio opens only for a Blog Writer, and the Mentor's team carries roles.
assert.ok(!('error' in tmt.buildTakeMeThereCard({ place: 'blog_top_list', assistantId: 6 }, roles)), 'Blog Writer: Blog Studio opens');
assert.ok('error' in tmt.buildTakeMeThereCard({ place: 'blog_top_list', assistantId: 1 }, roles), 'Social assistant: no Blog Studio button');
assert.ok(!('error' in tmt.buildTakeMeThereCard({ place: 'blog_top_list', assistantId: 6 }, [{ id: 6, name: 'Lyra' }])), 'role unknown: unchanged');
assert.ok(orch.includes("map((t) => ({ id: t.id, name: t.name, roleKey: t.roleKey ?? null }))"), 'the Mentor\'s team list carries roles');

// 5. One cap for the assistants read and named: the line names at most TAKE_ME_THERE_TEAM_CAP others.
const cap = (tmt as any).TAKE_ME_THERE_TEAM_CAP as number;
assert.ok(Number.isInteger(cap) && cap > 0);
const many = [lyra, ...Array.from({ length: cap + 5 }, (_, i) => ({ id: 100 + i, name: `A${i}` }))];
const named = (lineFor(lyra, many).match(/\b1\d\d = A\d+/g) || []).length;
assert.strictEqual(named, cap, 'names exactly the cap');
assert.ok(orch.includes('.limit(TAKE_ME_THERE_TEAM_CAP)'), 'and reads the same number');

console.log('repro-issue-68: Take Me There on every assistant\'s chat ✓');
