// tests/repro-issue-73.test.ts
// Fix pipeline #73 (owner, 2026-11-17): "In the Note Taker, there is no UI/chat ability to create Asana, Jira, Notion or
// Slack items. You have to do this in the connections panel which is not intuitive." Approving a meeting ran every
// switched-on hand-off, and that was the only way anything left. Owner, 2026-11-24: build "Send to" — a row on each
// meeting card and a chat card, both the same server action (assistant-records.ts `sendTo`).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { approvedRecently, isMeetingSendTarget, meetingSendState } from '../src/utils/meeting-send-to';
import { buildMeetingActionCard, meetingActionFromUiElement, sendToBlock } from '../src/utils/chat-meeting-action';

const root = join(__dirname, '..');

// 1. "Is it sent?" — one rule for the Inbox, the chat and the server.
const data = { tasks: [{ description: 'a' }, { description: 'b' }], handoffs: { slack_post_summary: { sentAt: '2026-11-20T10:00:00Z' }, notion_create_page: { claimedAt: '2026-11-20T10:00:00Z' } }, followupSentAt: '2026-11-20T10:01:00Z' };
assert.ok(meetingSendState('slack_post_summary', data).sent, 'Slack stamped sent');
assert.ok(!meetingSendState('notion_create_page', data).sent, 'Notion only claimed, not sent');
assert.ok(meetingSendState('email_meeting_followup', data).sent, 'an older followupSentAt counts');
assert.deepStrictEqual(meetingSendState('jira_create_tasks', data, { total: 2, synced: 1 }), { sent: false, partly: true, sentAt: null, sending: false });

// Review on PR #853: synced items count only for the tool they went to — items in Jira are not "sent to Asana".
const inJira = { total: 2, items: [{ syncStatus: 'synced', provider: 'jira' }, { syncStatus: 'synced', provider: 'jira' }] };
assert.ok(meetingSendState('jira_create_tasks', data, inJira).sent, 'in Jira');
assert.ok(!meetingSendState('asana_create_tasks', data, inJira).sent, 'not in Asana');
assert.ok(!meetingSendState('asana_create_tasks', data, { total: 2, synced: 2, syncedBy: { jira: 2, asana: 0 } }).sent, 'the chat snapshot counts by tool too');
assert.match(sendToBlock('asana_create_tasks', ['asana_create_tasks'], data, { total: 2, synced: 2, syncedBy: { jira: 2, asana: 0 } }) ?? 'can go', /can go/, 'so Asana can still be sent');

// Review on PR #853: just approved, the approval's own job is sending — "Sending…", not another button.
const now = Date.parse('2026-11-24T10:00:00Z');
assert.ok(approvedRecently('approved', '2026-11-24T09:58:00Z', now) && !approvedRecently('approved', '2026-11-24T09:40:00Z', now) && !approvedRecently('pending_approval', '2026-11-24T09:59:00Z', now));
assert.ok(meetingSendState('notion_create_page', {}, null, { approvedRecently: true, now }).sending, 'just approved: sending');
assert.ok(meetingSendState('notion_create_page', { handoffs: { notion_create_page: { claimedAt: '2026-11-24T09:55:00Z' } } }, null, { now }).sending, 'claimed 5 minutes ago: sending');
assert.ok(!meetingSendState('notion_create_page', { handoffs: { notion_create_page: { claimedAt: '2026-11-24T09:00:00Z' } } }, null, { now }).sending, 'an old claim: offer the button again');
assert.ok(!meetingSendState('email_meeting_followup', { followupNotSent: true }, null, { approvedRecently: true, now }).sending, 'a follow-up held for no mailbox is not "sending"');
assert.ok(meetingSendState('asana_create_tasks', data, { total: 2, synced: 2 }).sent);
assert.ok(!isMeetingSendTarget('hubspot_update_record') && isMeetingSendTarget('slack_post_summary'));

// 2. When a send can't go — the same reasons the server gives.
assert.match(sendToBlock('notion_create_page', ['slack_post_summary'], data) ?? '', /isn’t switched on/);
assert.match(sendToBlock('slack_post_summary', ['slack_post_summary'], data) ?? '', /Already sent to Slack/);
assert.strictEqual(sendToBlock('notion_create_page', ['notion_create_page'], data), null, 'Notion can go');
assert.match(sendToBlock('jira_create_tasks', ['jira_create_tasks'], { tasks: [] }) ?? '', /no action items/);
assert.match(sendToBlock('jira_create_tasks', ['jira_create_tasks'], data, { total: 2, synced: 2 }) ?? '', /already in Jira/);

// 3. The chat card: only for an approved meeting, naming a real tool.
const req = meetingActionFromUiElement({ type: 'meeting_action_proposal', action: 'send_to', recordId: '#7', target: 'notion_create_page' });
assert.ok(req && req.action === 'send_to' && req.target === 'notion_create_page', 'the model can ask for send_to');
const approved = buildMeetingActionCard({ id: 7, title: 'Kick-off', approvalStatus: 'approved', data }, 3, req!);
assert.strictEqual(approved.blocked, null);
assert.strictEqual(approved.targetLabel, 'Notion');
const pending = buildMeetingActionCard({ id: 7, title: 'Kick-off', approvalStatus: 'pending_approval', data }, 3, req!);
assert.match(pending.blocked ?? '', /Approve it first/, 'a waiting meeting is approved, not sent on');
const bad = buildMeetingActionCard({ id: 7, title: 'Kick-off', approvalStatus: 'approved', data }, 3, { ...req!, target: 'carrier_pigeon' });
assert.match(bad.blocked ?? '', /Which tool/);

// 4. The Inbox card's "Send to" row — the real function from assistants.js.
const aj = readFileSync(join(root, 'assistants.js'), 'utf8');
const grab = (name: string) => { const st = aj.indexOf(`function ${name}(`); let i = aj.indexOf('{', st), d = 0; for (; i < aj.length; i++) { if (aj[i] === '{') d++; else if (aj[i] === '}' && --d === 0) break; } return aj.slice(st, i + 1); };
function row(targets: unknown, r: Record<string, unknown>): string {
    const ctx: any = { _rqSendTargets: targets, _rqEsc: (s: unknown) => String(s ?? ''), window: {} };
    vm.createContext(ctx);
    vm.runInContext(`${grab('_rqMeetingSendTo')}\nthis.f = _rqMeetingSendTo;`, ctx);
    return ctx.f(r);
}
const T = [{ actionType: 'slack_post_summary', label: 'Slack' }, { actionType: 'notion_create_page', label: 'Notion' }, { actionType: 'jira_create_tasks', label: 'Jira', tasks: true }];
const live = row(T, { recordType: 'meeting', approvalStatus: 'approved', data, sendState: { slack_post_summary: { sent: true }, notion_create_page: { sent: false }, jira_create_tasks: { sent: false, partly: true } } });
assert.ok(live.includes('✓ Sent to Slack'), 'what has gone');
assert.ok(live.includes("sendTo:notion_create_page") && live.includes('Send to Notion'), 'a button for what has not');
assert.ok(live.includes('Send the rest to Jira'), 'and the rest of the action items');
const sending = row(T, { recordType: 'meeting', approvalStatus: 'approved', data: {}, sendState: { slack_post_summary: { sending: true }, notion_create_page: {}, jira_create_tasks: {} } });
assert.ok(sending.includes('Sending to Slack…') && !sending.includes('sendTo:slack_post_summary'), 'while it is being sent: no button');
assert.ok(row(T, { recordType: 'meeting', approvalStatus: 'pending_approval', data: {} }).includes('Approving sends it to: Slack, Notion, Jira'), 'before approval: where it will go');
assert.ok(row([], { recordType: 'meeting', approvalStatus: 'approved', data: {} }).includes("_openBriefDrawer?.('platforms')"), 'nothing on: where to switch one on');

// 5. The server: one action for both, through the same runner, never sending twice.
const srv = readFileSync(join(root, 'netlify/functions/assistant-records.ts'), 'utf8');
const block = srv.slice(srv.indexOf('if (body.sendTo !== undefined) {'), srv.indexOf('// ── "Send the follow-up now" (Inbox)'));
assert.ok(block.includes('LIVE_APPROVAL.has(') && block.includes("code: 'target_off'") && block.includes("code: 'already_sent'"));
assert.ok(block.indexOf('materialiseActionItems(db, orgId, m)') < block.indexOf('enqueueHandoffOnApproval(db, orgId, m, [target])'), 'tasks: the ledger first, so only missing items are filed');
const reg = readFileSync(join(root, 'src/components/disruptive-ui-registry.js'), 'utf8');
assert.ok(reg.includes("if (ui.action === 'send_to' && typeof ui.target === 'string') return { id, sendTo: ui.target };"), 'the chat card uses the same PATCH');

console.log('repro-issue-73: Send to from the Inbox and the chat ✓');
