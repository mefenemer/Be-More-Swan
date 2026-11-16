// Meeting Note Taker step 6: the chat sees its meetings and acts on one through the Inbox's own PATCH
// (docs/meeting-note-taker-finish-plan.md). Run: npx tsx tests/meeting-chat-review.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../netlify/functions/chat-orchestrator';
import {
    MEETING_ACTION_PROPOSAL_TYPE, buildMeetingActionCard, findAttendee, formatMeetingsSnapshot, meetingActionFromUiElement,
    meetingActionsPromptBlock, meetingAttendees, meetingDataHash, settledReason,
} from '../src/utils/chat-meeting-action';

const read = (f: string) => readFileSync(f, 'utf8');

const data = {
    type: 'action_item_assignment',
    meetingSummary: '• Vendor A',
    attendees: [{ name: 'Sarah Jones', email: 'sarah@example.com' }, { name: 'Tom Hill', email: null }, { name: 'Tomasz Nowak', email: '' }],
    followupEmail: { subject: 'Thanks all', body: 'We chose vendor A.' },
    tasks: [{ description: 'Chase legal', assignee: 'Sarah', dueDate: null }],
};
const waiting = { id: 41, title: 'Q3 review', approvalStatus: 'pending_approval', data };

// ── 1. The snapshot ─────────────────────────────────────────────────────────────
const snap = formatMeetingsSnapshot(3, 1, [
    { ...waiting, updatedAt: new Date('2026-11-15T09:00:00Z') },
    { id: 40, title: 'Ops sync', approvalStatus: 'approved', data: { tasks: [] }, updatedAt: '2026-11-14T09:00:00Z' },
]);
assert.match(snap, /^YOUR MEETINGS RIGHT NOW \(newest first; 3 in all, 1 waiting for approval; showing the latest 2\)/);
assert.ok(snap.includes('#41 "Q3 review" — waiting for approval · 2026-11-15 · 1 action item · no email for: Tom Hill, Tomasz Nowak'));
assert.ok(snap.includes('follow-up email — subject: "Thanks all"; body: "We chose vendor A."'), 'a waiting meeting shows its follow-up');
assert.ok(snap.includes('#40 "Ops sync" — approved · 2026-11-14 · 0 action items') && !/#40[^\n]*\n\s+follow-up/.test(snap), 'an approved one does not');
assert.equal(formatMeetingsSnapshot(0, 0, []), 'YOUR MEETINGS RIGHT NOW: none yet. Nothing is waiting for approval.');
assert.ok(meetingActionsPromptBlock(null).includes('could not be read this turn') && meetingActionsPromptBlock(null).includes('Do not propose a meeting action'));
assert.ok(meetingActionsPromptBlock(snap).startsWith('YOUR MEETINGS RIGHT NOW (newest'));

// The chat prompt carries it; the "New meeting" form's prompt does not (it acts on nothing).
assert.equal(ROUTES.meeting_note_taker.usesMeetingsSnapshot, true);
const prompt = ROUTES.meeting_note_taker.buildRolePrompt({
    business: { name: 'Swan Cafe', industry: null, description: null }, assistantName: 'Note Taker', jobRole: null,
    baseSystemPrompt: null, onboardingContext: {}, attachmentsBlock: null, meetingsSnapshot: snap,
} as unknown as Parameters<typeof ROUTES.meeting_note_taker.buildRolePrompt>[0]);
assert.ok(prompt.includes(snap) && prompt.includes('"type": "meeting_action_proposal"'));
assert.ok(!read('netlify/functions/meeting-minutes.ts').includes('meetingActionsPromptBlock'));

// ── 2. The model's proposal ─────────────────────────────────────────────────────
assert.deepEqual(meetingActionFromUiElement({ type: MEETING_ACTION_PROPOSAL_TYPE, action: 'reject', recordId: '#41', note: '  wrong\n meeting ' }), {
    action: 'reject', recordId: 41, attendeeName: null, email: null, subject: null, body: null, note: 'wrong meeting',
});
assert.equal(meetingActionFromUiElement({ type: MEETING_ACTION_PROPOSAL_TYPE, action: 'delete', recordId: 41 }), null);
assert.equal(meetingActionFromUiElement({ type: MEETING_ACTION_PROPOSAL_TYPE, action: 'approve', recordId: 'x' }), null);
assert.equal(meetingActionFromUiElement({ type: 'action_item_assignment' }), null);
const req = (r: Partial<ReturnType<typeof meetingActionFromUiElement> & object>) => ({
    action: 'approve' as const, recordId: 41, attendeeName: null, email: null, subject: null, body: null, note: null, ...r,
});

// ── 3. The card, from the row ───────────────────────────────────────────────────
const approve = buildMeetingActionCard(waiting, 7, req({}));
assert.equal(approve.blocked, null);
assert.deepEqual([approve.to, approve.missing, approve.tasks], [['sarah@example.com'], ['Tom Hill', 'Tomasz Nowak'], 1]);
assert.equal(approve.dataHash, meetingDataHash(data));
assert.match(buildMeetingActionCard({ ...waiting, approvalStatus: 'approved' }, 7, req({})).blocked!, /already approved/);
assert.match(buildMeetingActionCard({ ...waiting, approvalStatus: 'rejected' }, 7, req({ action: 'reject' })).blocked!, /was rejected/);

const add = buildMeetingActionCard(waiting, 7, req({ action: 'add_email', attendeeName: 'tom hill', email: 'tom@example.com' }));
assert.equal(add.blocked, null);
assert.equal(add.attendeeName, 'Tom Hill');
assert.deepEqual(add.attendees, [
    { name: 'Sarah Jones', email: 'sarah@example.com' }, { name: 'Tom Hill', email: 'tom@example.com' }, { name: 'Tomasz Nowak', email: '' },
], 'the whole list goes back, only Tom changed');
assert.match(buildMeetingActionCard(waiting, 7, req({ action: 'add_email', attendeeName: 'Tom', email: 'tom@example.com' })).blocked!, /More than one attendee matches "Tom"/);
assert.match(buildMeetingActionCard(waiting, 7, req({ action: 'add_email', attendeeName: 'Tom Hill', email: 'tom at example' })).blocked!, /isn’t a full email address/);
assert.match(buildMeetingActionCard(waiting, 7, req({ action: 'add_email', attendeeName: 'Sarah', email: 'SARAH@example.com' })).blocked!, /already has that address/);
assert.match(buildMeetingActionCard(waiting, 7, req({ action: 'add_email', attendeeName: 'Priya', email: 'p@example.com' })).blocked!, /No attendee called "Priya"/);
assert.deepEqual(findAttendee(meetingAttendees({ attendees: [{ name: 'Ana', email: null }, { name: 'Bo', email: 'b@x.io' }] }), null), { index: 0 }, 'the only one missing an address');

const edit = buildMeetingActionCard(waiting, 7, req({ action: 'edit_followup', body: 'We chose vendor A. Legal by Friday.' }));
assert.equal(edit.blocked, null);
assert.deepEqual(edit.before, { subject: 'Thanks all', body: 'We chose vendor A.' });
assert.deepEqual(edit.followupEmail, { subject: 'Thanks all', body: 'We chose vendor A. Legal by Friday.' }, 'subject kept when not changed');
assert.match(buildMeetingActionCard(waiting, 7, req({ action: 'edit_followup' })).blocked!, /Say what the new follow-up/);
assert.match(buildMeetingActionCard(waiting, 7, req({ action: 'edit_followup', body: 'We chose vendor A.' })).blocked!, /as it already stands/);

assert.equal(buildMeetingActionCard(waiting, 7, req({ action: 'reject', note: 'Wrong client' })).note, 'Wrong client');

// ── 4. A stored card, re-checked when the chat reopens ──────────────────────────
const asUi = (c: object) => c as unknown as Record<string, unknown>;
assert.equal(settledReason(asUi(approve), waiting), null);
assert.match(settledReason(asUi(approve), { ...waiting, approvalStatus: 'approved' })!, /was approved/);
assert.match(settledReason(asUi(approve), null)!, /no longer exists/);
const tomSaved = { ...data, attendees: [data.attendees[0], { name: 'Tom Hill', email: 'tom@example.com' }, data.attendees[2]] };
assert.match(settledReason(asUi(add), { ...waiting, data: tomSaved })!, /^Done — Tom Hill’s address is saved/);
assert.match(settledReason(asUi(edit), { ...waiting, data: { ...data, followupEmail: { subject: 'Thanks all', body: 'We chose vendor A. Legal by Friday.' } } })!, /^Done — the follow-up email is saved/);
assert.match(settledReason(asUi(edit), { ...waiting, data: { ...data, followupEmail: { subject: 'Edited in the Inbox', body: 'x' } } })!, /has changed since this card was made/);
assert.equal(settledReason(asUi(approve), { ...waiting, data: tomSaved }), null, 'an approve card survives an address being added');

// ── 5. Wiring: the orchestrator rebuilds it, every reopened chat re-checks it ───
const orch = read('netlify/functions/chat-orchestrator.ts');
assert.ok(orch.includes('resolveMeetingActionProposal(db, orgId, session.aiAssistantId, meetingActionReq)'));
assert.ok(orch.includes('buildMeetingsSnapshot(db, orgId, session.aiAssistantId)'));
assert.ok(read('src/utils/chat-card-refresh.ts').includes('refreshMeetingActionCards(db, organisationId, aiAssistantId, out)'));

// ── 6. The click is the Inbox's own PATCH, with the Inbox editor's keys ─────────
const reg = read('src/components/disruptive-ui-registry.js');
const fn = reg.slice(reg.indexOf('function meetingActionPatch('), reg.indexOf('function renderMeetingActionProposalCard('));
assert.ok(fn.includes("return { id, approvalStatus: 'approved' };"));
assert.ok(fn.includes('return { id, dataMerge: { attendees:'));
assert.ok(fn.includes('return { id, dataMerge: { followupEmail: ui.followupEmail } };'));
assert.ok(fn.includes("return { id, approvalStatus: 'rejected', ...(ui.note ? { feedback: ui.note } : {}) };"));
const card = reg.slice(reg.indexOf('function renderMeetingActionProposalCard('), reg.indexOf("register('meeting_action_proposal'"));
assert.ok(card.includes("fetch('/.netlify/functions/assistant-records', {") && card.includes("method: 'PATCH'"));
assert.ok(!/sendGmail|sync-action|postSyncAction/.test(card), 'the card sends nothing of its own');
assert.ok(read('assistants.js').includes('attendees[Number(f.key)].email = f.value'), 'the Inbox writes attendees[i].email too');

console.log('meeting-chat-review: all checks passed');
