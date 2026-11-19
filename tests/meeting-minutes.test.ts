// Meeting Note Taker step 5: "New meeting" writes a meeting up without the chat, and both paths use the
// SAME prompt, parsing and filing (docs/meeting-note-taker-finish-plan.md). Run: npx tsx tests/meeting-minutes.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES, hubRecordsFromUiElement } from '../netlify/functions/chat-orchestrator';
import { meetingFormMessage } from '../netlify/functions/meeting-minutes';
import {
    FORM_CHANNEL_BLOCK, MEETING_MINUTES_MAX_TOKENS, MEETING_MINUTES_MODEL, buildMeetingMinutesPrompt,
    meetingDestinationLabel, meetingHubRecord, normaliseMinutesCard,
} from '../src/utils/meeting-minutes';

const read = (f: string) => readFileSync(f, 'utf8');

// ── 1. One prompt: the chat's role prompt is the shared one plus the chat's own parts ──
const setup = { meetingPlatform: 'zoom', taskDestination: 'jira', summaryFormat: 'paragraph_narrative' };
const chatPrompt = ROUTES.meeting_note_taker.buildRolePrompt({
    business: { name: 'Swan Cafe', industry: null, description: null },
    assistantName: 'Note Taker', jobRole: null, baseSystemPrompt: null, onboardingContext: setup,
    attachmentsBlock: null,
} as unknown as Parameters<typeof ROUTES.meeting_note_taker.buildRolePrompt>[0]);
const core = buildMeetingMinutesPrompt({ ...setup, channelBlock: '@@CHANNEL@@' });
// Every line of the shared prompt except the channel block appears in the chat prompt, in order.
let from = 0;
for (const line of core.split('\n').filter((l) => l.trim() && !l.includes('@@CHANNEL@@'))) {
    const at = chatPrompt.indexOf(line, from);
    assert.ok(at >= 0, `chat prompt is missing a shared line: ${line.slice(0, 80)}`);
    from = at + line.length;
}
assert.ok(chatPrompt.includes('with the paperclip') && chatPrompt.includes('"New meeting" on the Inbox tab'), 'chat keeps its own paste/attach rules');
assert.ok(chatPrompt.includes('No transcript file is attached in this conversation.'));
assert.ok(chatPrompt.includes('SPREADSHEET FALLBACK'), 'the spreadsheet line stays chat-only');
assert.ok(chatPrompt.includes('Paragraph narrative') && chatPrompt.includes('"targetDestination": "Jira"'));
assert.equal(ROUTES.meeting_note_taker.model, MEETING_MINUTES_MODEL);
assert.equal(ROUTES.meeting_note_taker.maxTokens, MEETING_MINUTES_MAX_TOKENS);

const formPrompt = buildMeetingMinutesPrompt({ ...setup, channelBlock: FORM_CHANNEL_BLOCK });
assert.ok(formPrompt.includes('"New meeting" form') && formPrompt.includes('always include the card'));
assert.ok(!formPrompt.includes('SPREADSHEET FALLBACK') && !formPrompt.includes('paperclip'));
assert.equal(meetingDestinationLabel('monday'), 'Monday.com');
assert.equal(meetingDestinationLabel(undefined), 'your task tracker');
assert.equal(meetingDestinationLabel('Trello'), 'Trello');

// ── 2. One parser ───────────────────────────────────────────────────────────────
const card = normaliseMinutesCard({
    type: 'action_item_assignment',
    meetingTitle: '  Q3 review  ',
    meetingSummary: '• Vendor A',
    decisionsMade: ['Go with A', '', 7],
    identifiedRisks: 'not a list',
    targetDestination: 'Jira',
    attendees: [{ name: 'Sarah', email: 'sarah@example.com' }, { name: 'Tom', email: 'tom at example' }, { name: '', email: '' }, 'x'],
    followupEmail: { subject: 'Thanks', body: 'Recap' },
    tasks: [{ description: 'Chase legal', assignee: '', dueDate: '' }, { description: '  ' }],
    recordId: 99,
})!;
assert.deepEqual(card, {
    type: 'action_item_assignment', meetingTitle: 'Q3 review', meetingSummary: '• Vendor A',
    decisionsMade: ['Go with A'], identifiedRisks: [], targetDestination: 'Jira',
    attendees: [{ name: 'Sarah', email: 'sarah@example.com' }, { name: 'Tom', email: null }],
    followupEmail: { subject: 'Thanks', body: 'Recap' },
    tasks: [{ description: 'Chase legal', assignee: 'Unassigned', dueDate: null }],
});
assert.equal(normaliseMinutesCard({ type: 'action_item_assignment', meetingSummary: '', tasks: [] }), null, 'nothing extracted → no card');
assert.equal(normaliseMinutesCard({ type: 'mentor_support_request', summary: 'x' }), null);
assert.equal(normaliseMinutesCard(null), null);
assert.equal(normaliseMinutesCard({ type: 'ActionItemAssignmentCard', meetingSummary: 'S' })!.type, 'action_item_assignment');
assert.equal(normaliseMinutesCard({ type: 'action_item_assignment', meetingSummary: 'S', followupEmail: { subject: '', body: '' } })!.followupEmail, null);

// ── 3. One way to file it ───────────────────────────────────────────────────────
const rec = meetingHubRecord(card as unknown as Record<string, unknown>);
assert.deepEqual({ ...rec, data: undefined }, { recordType: 'meeting', title: 'Q3 review', status: 'open', data: undefined });
assert.equal(meetingHubRecord({ tasks: [] }, new Date('2026-11-15T10:00:00Z')).title, 'Meeting notes — 2026-11-15');
assert.equal(meetingHubRecord({ tasks: [] }).status, 'no actions');
assert.deepEqual(hubRecordsFromUiElement(card)[0], meetingHubRecord(card as unknown as Record<string, unknown>), 'chat files a card exactly as the form does');

// ── 4. The form's message ───────────────────────────────────────────────────────
assert.equal(meetingFormMessage({ text: 'Notes only', fileText: null, fileName: null }), 'Notes only');
assert.equal(meetingFormMessage({ text: '', fileText: 'Ana: Hi.', fileName: 'sync.vtt' }), 'Transcript from "sync.vtt":\n<<<TRANSCRIPT\nAna: Hi.\nTRANSCRIPT>>>');
assert.match(meetingFormMessage({ text: 'Tom left early', fileText: 'Ana: Hi.', fileName: 'a.txt' }), /^Notes from the user:\nTom left early\n\nTranscript from "a.txt"/);

// ── 5. Both paths call the same functions ─────────────────────────────────────────
const orch = read('netlify/functions/chat-orchestrator.ts');
const fn = read('netlify/functions/meeting-minutes.ts');
// The form calls persistHubRecordsWithTitles (it returns the saved title) — the same writer in hub-records.ts.
// The form's model call lives in src/utils/meeting-minutes-writer.ts, shared with automatic pick-up (meeting-pickup.ts).
const writer = read('src/utils/meeting-minutes-writer.ts');
assert.ok(fn.includes('writeMeetingMinutes(db, {'), 'the form calls the shared minutes writer');
for (const name of ['buildMeetingMinutesPrompt(', 'normaliseMinutesCard(', 'meetingHubRecord(', 'persistHubRecords', 'MEETING_MINUTES_MODEL', 'MEETING_MINUTES_MAX_TOKENS']) {
    assert.ok(orch.includes(name), `chat uses ${name}`);
    assert.ok(fn.includes(name) || writer.includes(name), `the form uses ${name}`);
}
assert.ok(!orch.includes('async function persistHubRecords('), 'one record writer (src/utils/hub-records.ts)');
assert.ok(!orch.includes('Attribution rules: assignee is'), 'the rules live only in meeting-minutes.ts');
// The form keeps the chat's guards: tenant, the meeting role only, transcript limits, moderation, fair use, rules.
for (const guard of ["requireTenant(event, db)", "assistant.roleKey !== 'meeting_note_taker'", 'readAttachments(db, orgId,', '{ transcripts: true }',
    'enforcePromptModeration(', "meterInteraction(db, orgId, 'chat')", 'loadAssistantRulesBlock(', 'FORM_CHANNEL_BLOCK']) {
    assert.ok(fn.includes(guard) || (guard === 'loadAssistantRulesBlock(' && writer.includes(guard)), `the form keeps: ${guard}`);
}
assert.ok(!/sendGmail|postSyncAction|enqueueHandoff|approvalStatus/.test(fn), 'the form sends nothing and approves nothing');
assert.match(read('netlify.toml'), /\[functions\.meeting-minutes\]\n {2}timeout = 26/);

// ── 6. The screen ───────────────────────────────────────────────────────────────
const reg = read('src/components/assistant-dashboard-registry.js');
const role = reg.slice(reg.indexOf('    meeting_note_taker: {'), reg.indexOf('    email_assistant: {'));
assert.ok(role.includes("primaryAction: { label: 'New meeting', kind: 'meetingForm' }"));
assert.ok(role.includes("newAction: { label: 'New meeting', kind: 'meetingForm' }"));
const app = read('assistants.js');
assert.ok(app.includes("toggleBtn('detail-rq-primary-btn', !rqIsRecords || !!rqNew);"));
assert.ok(app.includes("if (pa.kind === 'meetingForm') {") && app.includes('window.MeetingMinutesForm.open({'));
assert.ok(read('workspace.html').includes('<script src="/src/components/meeting-minutes-form.js"></script>'));
const form = read('src/components/meeting-minutes-form.js');
assert.ok(form.includes("fetch('/.netlify/functions/meeting-minutes'") && form.includes('window.MeetingMinutesForm = { open };'));
assert.ok(form.includes('nothing is sent until you approve'));

console.log('meeting-minutes: all checks passed');
