// Every assistant can raise a ticket the user asked for, and the Review page holds every assistant's waiting work
// (owner, 2026-11-07). Run: npx tsx tests/support-and-review-waiting.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../netlify/functions/chat-orchestrator';
import { ASSISTANT_BUILD } from '../src/config/assistant-build-manifest';
import { SUPPORT_REQUEST_PROMPT } from '../src/constants/assistant-shared-prompts';
import { mentorCardFromUiElement } from '../src/utils/mentor-cards';
import { ITEMS_PER_GROUP, toGroup } from '../src/utils/review-waiting';

const read = (f: string) => readFileSync(f, 'utf8');
const card = { type: 'mentor_support_request', summary: 'Send this to support', destination: 'issue', subject: 'Calendar blank', description: 'The calendar shows nothing.' };

// Each route's own reply parser keeps the card, in the reply shape the shared prompt asks for.
for (const role of Object.keys(ASSISTANT_BUILD)) {
    const route = ROUTES[role];
    assert.ok(route, `${role} has a route`);
    const parsed = route.parseResponse(JSON.stringify({ reply: 'The card is there to send.', uiElement: card }));
    assert.strictEqual((parsed.uiElement as { type?: string } | null)?.type, 'mentor_support_request', `${role}'s parser dropped the card`);
}

// It is the Mentor's card, checked the same way: nothing invented gets through.
assert.ok(!('error' in (mentorCardFromUiElement(card, 1) as object)));
assert.ok('error' in (mentorCardFromUiElement({ ...card, subject: '' }, 1) as object));

// Every structured route is told, and the card survives each route rebuilding its reply.
const orch = read('netlify/functions/chat-orchestrator.ts');
assert.ok(orch.includes('offersOwnCards ? SUPPORT_REQUEST_PROMPT : null'));
assert.match(SUPPORT_REQUEST_PROMPT, /only when the user asks/);
assert.match(SUPPORT_REQUEST_PROMPT, /only their click sends it/);
const put = orch.indexOf('if (supportCard) uiElement = supportCard;');
assert.ok(put > orch.lastIndexOf('emailAction ?? emailPartCard ?? audienceCard ?? reviewsCard ?? profileCard'), 'after the routes rebuild');
assert.ok(put < orch.indexOf('Reply ↔ persistence reconciliation'));
assert.ok(orch.includes('?? setupFieldCard ?? supportCard'), 'counts as a card, so no reply is reconciled as a claimed save');

// The ticket says which chat it came from; the Mentor's stay as they were, which mentor-activity.ts reads.
const apply = read('src/components/mentor-apply.js');
assert.ok(apply.includes("d.from ? `${d.from} chat` : 'Business Mentor chat'"));
assert.ok(read('src/components/disruptive-ui-registry.js').includes("from: typeof ui.from === 'string' ? ui.from : undefined"));

// A group's count is the whole number; only the first few are listed, newest first.
const rows = Array.from({ length: ITEMS_PER_GROUP + 3 }, (_, i) => ({ id: i + 1, title: `Lead ${i + 1}`, at: new Date(Date.UTC(2026, 10, i + 1)) }));
const g = toGroup({ kind: 'lead', label: 'Outreach emails to approve', tab: 'review-queue' }, { id: 9, name: 'Mira' }, rows);
assert.strictEqual(g.count, ITEMS_PER_GROUP + 3);
assert.strictEqual(g.items.length, ITEMS_PER_GROUP);
assert.strictEqual(g.items[0].title, `Lead ${ITEMS_PER_GROUP + 3}`);
assert.strictEqual(toGroup({ kind: 'x', label: 'x', tab: 'y' }, { id: 1, name: null }, [{ id: 1, title: ' ', at: null }]).items[0].title, 'Untitled');

// The lead predicate is the Outreach tab's, and an archived assistant has no rows here.
const waiting = read('src/utils/review-waiting.ts');
assert.ok(waiting.includes("IS DISTINCT FROM 'archived'"));
assert.ok(waiting.includes("WHEN ${stage} = 'review' THEN TRUE") && read('netlify/functions/assistant-records.ts').includes("WHEN ${stageSql} = 'review' THEN TRUE"));

// The pill and the list add the same number.
const ws = read('workspace.html');
assert.ok(ws.includes('socialCount + emailAwaiting + blogAwaiting + (waiting?.total || 0)'));
assert.ok(ws.includes('blogPosts.length : 0) + emails.length + (waiting?.total || 0)'));
console.log('support-and-review-waiting: all checks passed');
process.exit(0);
