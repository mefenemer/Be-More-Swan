// The Note Taker joins a call — step 3 (docs/note-taker-bot-plan.md §4): the Inbox's "Send to a call" and Live & upcoming
// strip, the chat card, and the round-5 review notes on the engine. Run: npx tsx tests/meeting-bot-ui.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    MEETING_BOT_PROPOSAL_TYPE, formatMeetingBotsSnapshot, meetingBotFromUiElement, meetingBotPromptBlock,
} from '../src/utils/chat-meeting-bot';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); passed++; } catch (err) { console.error(`✗ ${name}`); throw err; }
};
const read = (p: string) => readFileSync(p, 'utf8');

/** The real component, run in a sandbox with a bare window, for its pure helpers. */
function loadComponent() {
    const sandbox: Record<string, unknown> = { window: {} as Record<string, unknown>, document: {}, console };
    vm.runInNewContext(read('src/components/meeting-bots.js'), sandbox);
    return (sandbox.window as { MeetingBots: Record<string, (...a: unknown[]) => unknown> }).MeetingBots;
}
const NOW = Date.parse('2026-11-19T12:00:00Z');
const bot = (over: Record<string, unknown>) => ({
    id: 1, assistantId: 21, platform: 'google_meet', platformLabel: 'Google Meet', title: 'Weekly <call>', meetingUrl: 'https://meet.google.com/abc-defg-hij',
    joinAt: new Date(NOW - 5 * 60_000).toISOString(), status: 'in_call', statusWords: 'In the call', statusReason: null, joinedAt: null, leftAt: null, minutesInCall: null, recordId: null,
    ...over,
});

(async () => {

// ── The strip ────────────────────────────────────────────────────────────────────────────────────

await test('strip rows: booked → Cancel, live → Remove from call, done → minutes in the Inbox; names are escaped', () => {
    const MB = loadComponent();
    const live = MB._rowHtml(bot({}), NOW) as string;
    assert.match(live, /Remove from call/);
    assert.match(live, /Weekly &lt;call&gt;/);
    assert.ok(!live.includes('<call>'), 'escaped');
    assert.match(live, /5 min ago/);
    const booked = MB._rowHtml(bot({ status: 'scheduled', statusWords: 'Booked', joinAt: new Date(NOW + 3600_000).toISOString() }), NOW) as string;
    assert.match(booked, />Cancel</);
    const done = MB._rowHtml(bot({ status: 'done', statusWords: 'Done', recordId: 900 }), NOW) as string;
    assert.match(done, /Minutes in your Inbox/);
    assert.ok(!/data-mb-remove/.test(done));
});

await test('strip says WHY a bot stopped (plan §3), in words', () => {
    const MB = loadComponent();
    assert.match(MB._rowHtml(bot({ status: 'not_admitted', statusWords: 'Not let in', statusReason: 'timeout_exceeded_waiting_room' }), NOW) as string, /Nobody let it in within 10 minutes/);
    assert.match(MB._rowHtml(bot({ status: 'failed', statusWords: "Couldn't join", statusReason: 'something_new' }), NOW) as string, /meeting service blocked the Note Taker/);
});

await test('the strip shows open bots and recent problems, not old history', () => {
    const MB = loadComponent();
    const rows = MB._visibleBots([
        bot({ id: 1 }),
        bot({ id: 2, status: 'failed', joinAt: new Date(NOW - 2 * 3600_000).toISOString() }),
        bot({ id: 3, status: 'failed', joinAt: new Date(NOW - 30 * 3600_000).toISOString() }),
        bot({ id: 4, status: 'cancelled' }),
        bot({ id: 5, status: 'done', recordId: 9, leftAt: new Date(NOW - 3600_000).toISOString() }),
    ], NOW) as { id: number }[];
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 5]);
    assert.equal(MB._stripHtml([], NOW), '', 'nothing to show → no box');
});

await test('the dialog\'s cost line quotes the live weight (B3), and says nothing is charged at 0', () => {
    const MB = loadComponent();
    assert.equal(MB._costWords({ tasksPer5Min: 1 }), 'Uses 1 task for each started 5 minutes it’s in the call (about 12 an hour). Nothing if it isn’t let in.');
    assert.equal(MB._costWords({ tasksPer5Min: 0 }), 'Nothing is charged for this yet.');
});

await test('the dialog: Meet and Teams only, the consent reminder, the DPA notice, and one send action with source link', () => {
    const src = read('src/components/meeting-bots.js');
    assert.match(src, /Google Meet or Microsoft Teams\. Copy it from the meeting invite\./);
    assert.match(src, /Tell everyone in the meeting<\/strong> that the Note Taker is recording\. In some places you need their consent\./);
    assert.match(src, /accept the updated Data Processing Agreement \(version 1\.2\)/);
    assert.ok(src.includes("action: 'send', assistantId: st.assistantId") && src.includes("source: 'link'"));
    assert.ok(src.includes("fetch('/.netlify/functions/meeting-bots'"), 'the one server action');
    assert.ok(!/recall\.ai/i.test(src), 'never talks to Recall');
});

await test('the Inbox mounts it for the Note Taker only, and the GET hides everything while the flag is off', () => {
    const a = read('assistants.js');
    assert.ok(a.includes("if (data.roleKey === 'meeting_note_taker') window.MeetingBots?.mount({ assistantId: data.id, assistantName: data.name });"));
    assert.ok(a.includes('else window.MeetingBots?.unmount();'));
    const html = read('assistant-detail.html');
    assert.match(html, /id="detail-rq-bot-btn" style="display:none"/);
    assert.match(html, /id="meeting-bots-strip" class="hidden" style="display:none"/);
    assert.ok(read('workspace.html').includes('<script src="/src/components/meeting-bots.js"></script>'));
    const ep = read('netlify/functions/meeting-bots.ts');
    assert.ok(ep.indexOf('isFeatureEnabled(organisationId, MEETING_BOT_FLAG)') < ep.indexOf('listMeetingBots(db, organisationId, assistantId)'));
    assert.match(ep, /if \(!available\) return json\(200, \{ available: false, dpaAccepted: false, tasksPer5Min: 0, bots: \[\] \}\);/);
});

await test('a bot meeting in the Inbox says "Joined by Note Taker"; a picked-up one still says "Picked up from"', () => {
    const a = read('assistants.js');
    const fn = a.slice(a.indexOf('function _rqMeetingPickedUp'), a.indexOf('function _rqMeetingPickedUp') + 1600);
    assert.ok(fn.indexOf("if (p.via === 'bot')") < fn.indexOf('Picked up from'));
    assert.match(fn, /Joined by Note Taker · \$\{_rqEsc\(p\.label\)\}/);
});

await test('B7: a Zoom link is refused before anything reaches Recall unless meeting_bot_zoom is on', () => {
    const db = read('src/utils/meeting-bot-db.ts');
    const send = db.slice(db.indexOf('export async function sendMeetingBot'), db.indexOf('// ── Listing and removing'));
    assert.ok(send.indexOf("link.platform === 'zoom' && !(await isFeatureEnabled(i.organisationId, MEETING_BOT_ZOOM_FLAG))") < send.indexOf('createRecallBot('));
    assert.match(read('src/utils/meeting-bot.ts'), /export const MEETING_BOT_ZOOM_FLAG = 'meeting_bot_zoom';/);
});

// ── Chat ─────────────────────────────────────────────────────────────────────────────────────────

await test('chat snapshot: platforms, DPA, cost and the booked/live bots by id', () => {
    const t = formatMeetingBotsSnapshot({ dpaAccepted: false, tasksPer5Min: 1, zoom: false, rows: [
        { id: 7, platform: 'teams', title: 'Board', joinAt: new Date('2026-11-20T14:00:00Z'), status: 'scheduled' },
    ] });
    assert.match(t, /Google Meet and Microsoft Teams calls/);
    assert.ok(!/Zoom/.test(t), 'Zoom not offered while held back');
    assert.match(t, /IT CANNOT JOIN YET/);
    assert.match(t, /about 12 an hour/);
    assert.match(t, /bot #7 · Microsoft Teams · "Board" · booked for 2026-11-20 14:00 UTC · Booked/);
    assert.match(formatMeetingBotsSnapshot({ dpaAccepted: true, tasksPer5Min: 1, zoom: true, rows: [] }), /None booked or in a call now/);
});

await test('chat prompt: absent while the flag is off; when on, the model only proposes and never claims it sent', () => {
    assert.equal(meetingBotPromptBlock(null), '');
    const p = meetingBotPromptBlock('THE NOTE TAKER IN CALLS: …');
    assert.match(p, /never say it HAS been sent, booked or removed/);
    assert.match(p, /never invent or complete a link/);
    assert.match(p, /"type": "meeting_bot_proposal"/);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /usesMeetingBots: true,/);
    assert.match(orch, /meetingBotPromptBlock\(rc\.meetingBotsSnapshot \?\? null\),\n        \]\.filter\(Boolean\)\.join/);
    assert.ok(orch.includes('resolveMeetingBotProposal(db, orgId, session.aiAssistantId, botReq)'), 'rebuilt from facts');
});

await test('chat card shape check: send needs a link; remove needs a bot id; anything else is nothing', () => {
    assert.deepEqual(meetingBotFromUiElement({ type: MEETING_BOT_PROPOSAL_TYPE, action: 'send', meetingUrl: ' https://meet.google.com/abc-defg-hij ', title: '  Weekly   call ' }),
        { action: 'send', meetingUrl: 'https://meet.google.com/abc-defg-hij', joinAt: null, title: 'Weekly call', botId: null });
    assert.equal(meetingBotFromUiElement({ type: MEETING_BOT_PROPOSAL_TYPE, action: 'send' }), null);
    assert.deepEqual(meetingBotFromUiElement({ type: MEETING_BOT_PROPOSAL_TYPE, action: 'remove', botId: '#12' }), { action: 'remove', meetingUrl: null, joinAt: null, title: null, botId: 12 });
    assert.equal(meetingBotFromUiElement({ type: MEETING_BOT_PROPOSAL_TYPE, action: 'remove', botId: 'x' }), null);
    assert.equal(meetingBotFromUiElement({ type: 'meeting_action_proposal', action: 'send', meetingUrl: 'x' }), null);
});

await test('chat card: drawn by the registry, a blocked card has no button, and the click is the same server action with source chat', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /register\('meeting_bot_proposal', renderMeetingBotProposalCard\);/);
    const fn = reg.slice(reg.indexOf('function renderMeetingBotProposalCard'), reg.indexOf("register('meeting_bot_proposal'"));
    assert.ok(fn.includes('if (blocked) return el;'));
    assert.ok(fn.includes("fetch('/.netlify/functions/meeting-bots'") && fn.includes("source: 'chat'"));
    assert.ok(!/recall\.ai/i.test(fn));
    assert.match(read('src/utils/assistant-chat-capabilities.ts'), /meeting_bot_proposal: 'Send the Note Taker into a Meet or Teams call/);
    assert.match(read('src/config/chat-capabilities.generated.ts'), /"meeting_bot_proposal"/);
});

// ── Round 5 review notes on the engine (#769) ────────────────────────────────────────────────────

await test('round 5: each Recall call in the poll is cut off at 5 s and a batch only starts if a whole call still fits', () => {
    const db = read('src/utils/meeting-bot-db.ts');
    assert.match(db, /export const POLL_CALL_TIMEOUT_MS = 5_000;/);
    assert.ok(db.includes('Date.now() - started + POLL_CALL_TIMEOUT_MS <= budgetMs'));
    assert.ok(db.includes('getRecallBot(row.recallRegion as RecallRegion, row.recallBotId!, POLL_CALL_TIMEOUT_MS)'));
    assert.ok(db.includes('deleteBotMedia(db, bot, POLL_CALL_TIMEOUT_MS)'));
});

await test('round 5: archiving or purging cancels a bot still being sent (no Recall id yet), so the guarded save withdraws it', () => {
    const db = read('src/utils/meeting-bot-db.ts');
    const w = db.slice(db.indexOf('export async function withdrawMeetingBots'));
    const cancel = w.indexOf('isNull(meetingBots.recallBotId), inArray(meetingBots.status, [...OPEN_BOT_STATUSES])');
    assert.ok(cancel > 0 && cancel < w.indexOf('const rows = await db.select()'), 'id-less open bots cancelled first');
});

console.log(`meeting-bot-ui: ${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
