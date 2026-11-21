// The Note Taker joins a call — step 3 (docs/note-taker-bot-plan.md §4): the Inbox's "Send to a call" and Live & upcoming
// strip, the chat card, and the round-5 review notes on the engine. Run: npx tsx tests/meeting-bot-ui.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { botWriteUp, runBatchesWithinBudget } from '../src/utils/meeting-bot';
import {
    MEETING_BOT_PROPOSAL_TYPE, SEND_CARD_FRESH_MS, botCardSettledReason, formatMeetingBotsSnapshot, meetingBotFromUiElement, meetingBotPromptBlock,
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

await test('staging test 2026-11-21: a finished call never vanishes — the strip says what happened to its minutes', () => {
    const MB = loadComponent();
    const done = (over: Record<string, unknown>) => bot({ status: 'done', statusWords: 'Done', leftAt: new Date(NOW - 10 * 60_000).toISOString(), ...over });
    assert.match(MB._rowHtml(done({ writeUp: 'writing' }), NOW) as string, /Writing the minutes…/);
    assert.match(MB._rowHtml(done({ writeUp: 'no_meeting', writeUpReason: 'no_meeting' }), NOW) as string, /No minutes: too little was said in the call to write them\./);
    assert.match(MB._rowHtml(done({ writeUp: 'not_written', writeUpReason: 'no_transcript' }), NOW) as string, /no transcript for this call/);
    assert.match(MB._rowHtml(done({ writeUp: 'not_written', writeUpReason: 'failed' }), NOW) as string, /The minutes couldn’t be written\./);
    const written = MB._rowHtml(done({ writeUp: 'written', recordId: 7 }), NOW) as string;
    assert.match(written, /Minutes in your Inbox/);
    assert.ok(!/No minutes|Writing/.test(written));
    // Visible for a day after the call, whatever happened to the minutes; gone after that.
    const rows = MB._visibleBots([
        done({ id: 10, writeUp: 'no_meeting', writeUpReason: 'no_meeting' }),
        done({ id: 11, writeUp: 'writing' }),
        done({ id: 12, writeUp: 'no_meeting', leftAt: new Date(NOW - 25 * 3600_000).toISOString(), joinAt: new Date(NOW - 25 * 3600_000).toISOString() }),
    ], NOW) as { id: number }[];
    assert.deepEqual(rows.map((r) => r.id), [10, 11]);
    const src = read('src/components/meeting-bots.js');
    assert.ok(src.includes("(b.status === 'done' && b.writeUp === 'writing')"), 'keeps refreshing until the minutes land');
});

await test('the server works out the minutes\' state from the import (botWriteUp) and the list sends it', () => {
    assert.deepEqual(botWriteUp({ status: 'done', joinedAt: 1 }, null), { writeUp: 'writing', writeUpReason: null }, 'done, import not made yet');
    assert.deepEqual(botWriteUp({ status: 'done', joinedAt: 1 }, { status: 'writing', skipReason: null, recordId: null }).writeUp, 'writing');
    assert.deepEqual(botWriteUp({ status: 'done', joinedAt: 1 }, { status: 'written', skipReason: null, recordId: 9 }).writeUp, 'written');
    assert.deepEqual(botWriteUp({ status: 'done', joinedAt: 1 }, { status: 'skipped', skipReason: 'no_meeting', recordId: null }), { writeUp: 'no_meeting', writeUpReason: 'no_meeting' });
    assert.deepEqual(botWriteUp({ status: 'done', joinedAt: 1 }, { status: 'skipped', skipReason: 'no_transcript', recordId: null }), { writeUp: 'not_written', writeUpReason: 'no_transcript' });
    assert.deepEqual(botWriteUp({ status: 'done', joinedAt: 1 }, { status: 'failed', skipReason: null, recordId: null }), { writeUp: 'not_written', writeUpReason: 'failed' });
    assert.equal(botWriteUp({ status: 'not_admitted', joinedAt: null }, null).writeUp, 'none', 'never in the call: no minutes expected');
    assert.equal(botWriteUp({ status: 'in_call', joinedAt: 1 }, null).writeUp, 'none');
    const db = read('src/utils/meeting-bot-db.ts');
    assert.ok(db.includes('importStatus: meetingImports.status, skipReason: meetingImports.skipReason'));
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

await test('review of #774: a reopened chat never re-offers an old send card, nor a remove card for a finished bot', () => {
    const t = new Date('2026-11-19T12:00:00Z');
    const fresh = { type: MEETING_BOT_PROPOSAL_TYPE, action: 'send', madeAt: new Date(t.getTime() - 60_000).toISOString() };
    assert.equal(botCardSettledReason(fresh, null, t), null, 'just made: still offered (a quick reload)');
    const old = { ...fresh, madeAt: new Date(t.getTime() - SEND_CARD_FRESH_MS - 1000).toISOString() };
    assert.match(botCardSettledReason(old, null, t) ?? '', /An earlier request/);
    assert.match(botCardSettledReason({ type: MEETING_BOT_PROPOSAL_TYPE, action: 'send' }, null, t) ?? '', /An earlier request/, 'no madeAt = settled');
    const rm = { type: MEETING_BOT_PROPOSAL_TYPE, action: 'remove', botId: 3 };
    assert.equal(botCardSettledReason(rm, { status: 'in_call' }, t), null);
    assert.match(botCardSettledReason(rm, { status: 'done' }, t) ?? '', /Already finished \(Done\)/);
    assert.match(botCardSettledReason(rm, { status: 'ended' }, t) ?? '', /Already finished/);
    assert.match(botCardSettledReason(rm, null, t) ?? '', /no longer exists/);
    const chain = read('src/utils/chat-card-refresh.ts');
    assert.ok(chain.includes('out = await refreshMeetingBotCards(db, organisationId, aiAssistantId, out);'), 'in the one refresh chain');
    const mod = read('src/utils/chat-meeting-bot.ts');
    assert.ok(mod.includes('madeAt: now.toISOString(), freshForMs: SEND_CARD_FRESH_MS'), 'send cards carry when they were made');
});

await test('review of #774: switching Note Takers mid-load never shows the first one\'s bots; a send with no link asks for it', () => {
    const c = read('src/components/meeting-bots.js');
    const r = c.slice(c.indexOf('async function refresh()'));
    assert.ok(r.indexOf('if (st.assistantId !== forId) return;') < r.indexOf('render();'));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes("asked === 'send'") && orch.includes('Paste the Google Meet or Microsoft Teams link from the invite.'));
});

// ── Round 5 review notes on the engine (#769) ────────────────────────────────────────────────────

await test('review of #774 (round 2): the budget helper ALWAYS runs the first batch, then stops when a whole call no longer fits', async () => {
    let t = 0;
    const clock = () => t;
    const seen: number[] = [];
    // A budget equal to one call's timeout: the old condition never started at all. Now the first batch runs.
    const r1 = await runBatchesWithinBudget([1, 2, 3, 4, 5, 6, 7], 5, 5_000, 5_000, async (n) => { seen.push(n); t += 1_000; return n * 10; }, clock);
    assert.deepEqual(r1, [10, 20, 30, 40, 50], 'first batch of 5 ran; the second didn\'t fit');
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    t = 0;
    const r2 = await runBatchesWithinBudget([1, 2, 3, 4, 5, 6, 7], 5, 20_000, 5_000, async (n) => { t += 100; return n; }, clock);
    assert.equal(r2.length, 7, 'room for both batches');
    assert.deepEqual(await runBatchesWithinBudget([], 5, 0, 5_000, async (n: number) => n, clock), []);
    const db = read('src/utils/meeting-bot-db.ts');
    assert.ok(db.includes('runBatchesWithinBudget(open, POLL_BATCH, budgetMs, POLL_CALL_TIMEOUT_MS, pollOne)'));
    assert.ok(db.includes('runBatchesWithinBudget(finished, POLL_BATCH, BOT_MEDIA_BUDGET_MS, POLL_CALL_TIMEOUT_MS,'));
    assert.match(db, /export const BOT_POLL_BUDGET_MS = 10_000;/);
    // Round 3: the stuck-import hand-offs run in batches within their own budget too, so the whole run stays ≤ ~23 s.
    assert.match(db, /export const BOT_IMPORT_BUDGET_MS = 5_000;/);
    assert.ok(db.includes('runBatchesWithinBudget(orphaned, POLL_BATCH, BOT_IMPORT_BUDGET_MS, POLL_CALL_TIMEOUT_MS,'));
    assert.ok(!/for \(const row of orphaned\)/.test(db), 'no unbounded one-at-a-time loop');
    assert.match(db, /export const BOT_MEDIA_BUDGET_MS = 8_000;/);
    assert.ok(!/mediaStarted/.test(db), 'the old never-true condition is gone');
    assert.ok(db.includes('getRecallBot(row.recallRegion as RecallRegion, row.recallBotId!, POLL_CALL_TIMEOUT_MS)'));
});

await test('review of #774 (round 2): a send card on screen expires at click; a failed read draws a "couldn\'t check" card, not a link question', () => {
    const mod = read('src/utils/chat-meeting-bot.ts');
    const reg = read('src/components/disruptive-ui-registry.js');
    const fn = reg.slice(reg.indexOf('function renderMeetingBotProposalCard'), reg.indexOf("register('meeting_bot_proposal'"));
    const click = fn.slice(fn.indexOf("el.addEventListener('click'"));
    assert.ok(click.indexOf('performance.now() - shownAt > fresh') < click.indexOf("fetch('/.netlify/functions/meeting-bots'"), 'checked before sending');
    // Round 3: timed from when the card appeared, with the server's RELATIVE freshForMs, never the device clock vs madeAt.
    assert.ok(!click.includes('Date.parse(ui.madeAt)'), 'no absolute server time against the device clock');
    assert.ok(fn.indexOf('const shownAt = performance.now();') < fn.indexOf("el.addEventListener('click'"));
    assert.ok(mod.includes('madeAt: now.toISOString(), freshForMs: SEND_CARD_FRESH_MS };'), 'a new card carries its freshness');
    assert.ok(mod.includes("freshForMs: Math.max(0, SEND_CARD_FRESH_MS - (now.getTime() - Date.parse(String(ui.madeAt))))"), 'a re-served card carries only what is left');
    const katch = mod.slice(mod.indexOf("console.error('[chat-meeting-bot] resolve failed"));
    assert.ok(katch.includes("if (req.action === 'send')") && katch.includes('I couldn’t check that just now, so nothing was sent.'));
});

await test('round 5: archiving or purging cancels a bot still being sent (no Recall id yet), so the guarded save withdraws it', () => {
    const db = read('src/utils/meeting-bot-db.ts');
    const w = db.slice(db.indexOf('export async function withdrawMeetingBots'));
    const cancel = w.indexOf('isNull(meetingBots.recallBotId), inArray(meetingBots.status, [...OPEN_BOT_STATUSES])');
    assert.ok(cancel > 0 && cancel < w.indexOf('const rows = await db.select()'), 'id-less open bots cancelled first');
});

console.log(`meeting-bot-ui: ${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
