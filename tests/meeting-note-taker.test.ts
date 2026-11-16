// Meeting Note Taker (Minute Taker): pins the text pipeline before launch (docs/meeting-note-taker-finish-plan.md
// steps 2–3). Chat card → saved meeting record → approval → follow-up email + one ticket per action item.
// Run: npx tsx tests/meeting-note-taker.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hubRecordsFromUiElement } from '../netlify/functions/chat-orchestrator';
import { buildActionPayload, buildEmailPayload, buildTasksPayload } from '../src/utils/scenario-engine';
import {
    actionItemRowsFromMeeting, createTasksResult, fileTickets, notConnectedResult, summariseActionItemSync,
} from '../src/utils/meeting-action-items';

const read = (f: string) => readFileSync(f, 'utf8');

async function main() {
    // ── 1. The chat card becomes one meeting record ───────────────────────────────
    const card = {
        type: 'action_item_assignment',
        meetingTitle: 'Q3 pipeline review — 4 Jul',
        meetingSummary: '• Vendor A chosen',
        decisionsMade: ['Go with vendor A'],
        identifiedRisks: [],
        attendees: [{ name: 'Sarah', email: 'sarah@example.com' }, { name: 'Tom', email: null }],
        followupEmail: { subject: 'Thanks all', body: 'Recap…' },
        tasks: [{ description: 'Chase legal', assignee: 'Sarah', dueDate: 'Friday' }],
    };
    const recs = hubRecordsFromUiElement(card);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].recordType, 'meeting');
    assert.equal(recs[0].title, 'Q3 pipeline review — 4 Jul');
    assert.equal(recs[0].status, 'open');
    assert.equal(recs[0].data, card, 'the whole card is the record data (the Inbox renders and edits it)');

    const noTasks = hubRecordsFromUiElement({ ...card, meetingTitle: '', tasks: [] });
    assert.equal(noTasks[0].status, 'no actions');
    assert.match(noTasks[0].title, /^Meeting notes — \d{4}-\d{2}-\d{2}$/, 'an untitled meeting is named by date');
    assert.deepEqual(hubRecordsFromUiElement(null), []);
    assert.deepEqual(hubRecordsFromUiElement({ type: 'something_else' }), []);

    // ── 2. Follow-up email payload: only real addresses, the reviewed draft, the footer name ──
    const subject = { recordType: 'meeting', recordId: 77, newStatus: 'MEETING_BOOKED', fields: { ...card, assistantName: 'Minute Taker' } };
    const email = buildEmailPayload(subject, {});
    assert.deepEqual(email.to, ['sarah@example.com'], 'an attendee with no address is left out, not guessed');
    assert.equal(email.subject, 'Thanks all');
    assert.equal(email.body, 'Recap…');
    assert.equal(email.assistantName, 'Minute Taker');

    const bad = buildEmailPayload({ ...subject, fields: { attendees: [{ name: 'X', email: 'not-an-address' }], meetingTitle: 'Ops sync', meetingSummary: 'Sum' } }, {});
    assert.deepEqual(bad.to, []);
    assert.equal(bad.subject, 'Follow-up: Ops sync', 'no draft subject → named after the meeting');
    assert.equal(bad.body, 'Sum', 'no draft body → the summary');
    const fallback = buildEmailPayload({ ...subject, fields: { contactEmail: ' one@example.com ' } }, {});
    assert.deepEqual(fallback.to, ['one@example.com']);
    assert.equal(fallback.subject, 'Meeting follow-up');

    // ── 3. Tasks payload: the ledger key + the recipe's stored target, never the tasks themselves ──
    const tasks = buildTasksPayload(subject, { projectKey: 'OPS', issueType: 'Task', asanaProjectGid: 42 });
    assert.deepEqual(tasks, { meetingRecordId: 77, projectKey: 'OPS', issueType: 'Task', asanaProjectGid: undefined });
    assert.equal(buildTasksPayload({ recordType: 'meeting', fields: {} }, {}).meetingRecordId, null);
    assert.deepEqual(buildActionPayload('email_meeting_followup', subject, {}).to, ['sarah@example.com']);
    assert.equal(buildActionPayload('jira_create_tasks', subject, { projectKey: 'OPS' }).meetingRecordId, 77);
    assert.equal(buildActionPayload('asana_create_tasks', subject, {}).meetingRecordId, 77);

    // ── 4. Materialise: one ledger row per task with a description ──────────────
    const rows = actionItemRowsFromMeeting(5, {
        id: 77, recordType: 'meeting', aiAssistantId: 9,
        data: { tasks: [
            { description: '  Chase legal  ', assignee: 'Sarah', dueDate: 'Friday' },
            { description: '', assignee: 'Nobody' },
            { description: 'Chase legal', assignee: 'Tom' },      // same task twice: first one wins
            null,
            { description: 'Send deck', assignee: 7 },
            { description: 'x'.repeat(2500) },
        ] },
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { organisationId: 5, aiAssistantId: 9, meetingRecordId: 77, description: 'Chase legal', assignee: 'Sarah', dueDate: 'Friday' });
    assert.equal(rows[1].assignee, null, 'a non-text owner is dropped');
    assert.equal(rows[2].description.length, 2000);
    assert.equal(actionItemRowsFromMeeting(5, { id: 1, recordType: 'meeting', aiAssistantId: 9, data: { actionItems: [{ description: 'Old key' }] } })[0].description, 'Old key');
    assert.deepEqual(actionItemRowsFromMeeting(5, { id: 1, recordType: 'lead', aiAssistantId: 9, data: card }), []);
    assert.deepEqual(actionItemRowsFromMeeting(5, { id: 1, recordType: 'meeting', aiAssistantId: 9, data: null }), []);

    // ── 5. "N of M synced" ───────────────────────────────────────────────────────
    const sum = summariseActionItemSync([{ syncStatus: 'synced' }, { syncStatus: 'synced' }, { syncStatus: 'failed' }, { syncStatus: 'pending' }, { syncStatus: 'skipped' }]);
    assert.deepEqual({ ...sum, items: sum.items.length }, { total: 5, synced: 2, failed: 1, pending: 1, skipped: 1, items: 5 });

    // ── 6. Filing tickets: synced, failed, and each stamped before the next is made ──
    const order: string[] = [];
    const filed = await fileTickets(
        [{ id: 1, description: 'A' }, { id: 2, description: 'B' }, { id: 3, description: 'C' }],
        async (row) => {
            order.push(`create ${row.id}`);
            if (row.id === 2) throw new Error('Project OPS does not exist');
            return { id: `T-${row.id}`, url: `https://example.atlassian.net/browse/T-${row.id}` };
        },
        async (o) => { order.push(`stamp ${o.row.id} ${o.ok ? 'ok' : 'failed'}`); },
    );
    assert.equal(filed.synced, 2);
    assert.equal(filed.failed, 1);
    assert.deepEqual(order, ['create 1', 'stamp 1 ok', 'create 2', 'stamp 2 failed', 'create 3', 'stamp 3 ok']);
    const failedOutcome = filed.outcomes[1];
    assert.ok(!failedOutcome.ok && failedOutcome.error === 'Project OPS does not exist');

    assert.deepEqual(createTasksResult('Jira', 2, 1, 3), {
        status: 200,
        body: { success: true, synced: 2, failed: 1, skipped: 0, total: 3, message: '2 of 3 action items filed to Jira, 1 failed.' },
    });
    assert.equal(createTasksResult('Asana', 0, 2, 2).status, 502, 'all failed → 502 so the job retries');
    assert.equal(createTasksResult('Asana', 1, 0, 1).body.message, '1 of 1 action item filed to Asana.');
    assert.deepEqual(notConnectedResult('Asana', 4).body, {
        success: true, synced: 0, failed: 0, skipped: 4, total: 4, message: "Asana isn't connected — 4 action items left unsynced.",
    });

    // The handlers use these helpers, so the tests above are the live behaviour.
    const sync = read('netlify/functions/sync-action.ts');
    assert.ok(sync.includes('await fileTickets(rows,'), 'sync-action files tickets through fileTickets');
    assert.ok(sync.includes('createTasksResult(providerLabel(provider)'));
    assert.ok(sync.includes('notConnectedResult(providerLabel(provider)'));
    const records = read('netlify/functions/assistant-records.ts');
    assert.ok(records.includes('actionItemRowsFromMeeting(orgId, record)'));
    assert.ok(records.includes('summariseActionItemSync(its)'));

    // ── 7. Step 3: one way to send — approval ─────────────────────────────────────
    const reg = read('src/components/disruptive-ui-registry.js');
    const start = reg.indexOf('function renderActionItemAssignmentCard(');
    const end = reg.indexOf("register('action_item_assignment', renderActionItemAssignmentCard);");
    assert.ok(start > 0 && end > start, 'card renderer found');
    const cardSrc = reg.slice(start, end);
    assert.ok(!cardSrc.includes('postSyncAction'), 'the meeting card never sends anything itself');
    assert.ok(!/slack_post_summary|notion_create_page|\/api\/actions\/sync/.test(cardSrc), 'no direct Slack/Notion push');
    assert.ok(!cardSrc.includes('sync is coming'), 'no "direct Jira sync is coming" line');
    assert.ok(cardSrc.includes("fetch('/.netlify/functions/assistant-records'"), 'Approve uses the Inbox PATCH');
    assert.ok(cardSrc.includes("approvalStatus: 'approved'"));
    assert.ok(cardSrc.includes('Nothing is sent until you approve'));

    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(!orch.includes('Live meeting/task-tool connections are not wired up yet'), 'out-of-date prompt line gone');
    // The minutes rules moved to src/utils/meeting-minutes.ts (step 5), shared with the New meeting form.
    assert.ok(read('src/utils/meeting-minutes.ts').includes('Nothing leaves the workspace until the user approves the meeting'));
    // The card learns its record id before the reply is saved, so Approve survives a reload.
    const persistAt = orch.indexOf('const hubRecordIds = await persistHubRecords(db, orgId, session.aiAssistantId, hubRecords);');
    const replyAt = orch.indexOf('const [assistantMessage] = await db.transaction(');
    assert.ok(persistAt > 0 && replyAt > persistAt, 'meeting record written before the reply row');
    assert.ok(orch.includes('recordId: hubRecordIds[0]'));

    console.log('meeting-note-taker: all checks passed');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
