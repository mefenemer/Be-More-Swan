// The Note Taker joins a call itself (docs/note-taker-bot-plan.md §4, step 2): the pure rules, Recall's signature,
// the hand-over to the meeting pick-up engine, and the order of the safety checks. Run: npx tsx tests/meeting-bot.test.ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
    ALONE_TIMEOUT_S, JOIN_MESSAGE_MAX, MEETING_BOT_FLAG, SCHEDULE_AHEAD_MS, WAITING_ROOM_TIMEOUT_S,
    botName, botPlatformOf, chargeUnits, cleanJoinAt, immediateJoinAt, cleanLengthLimit, cleanMeetingLink, joinMessage, minutesInCall,
    nextBotState, recallBotRequest, replayBotState, recallRegionFor, recallTranscriptLines, reserveUnits, verifyRecallSignature,
    type BotStateRow, type BotStatus,
} from '../src/utils/meeting-bot';
import { botExternalId, parseBotExternalId } from '../src/utils/meeting-bot-db';
import {
    sourceFor, writeImport, type ImportRelease, type ImportRow, type MeetingSource, type PickupStore, type WriterDeps,
} from '../src/utils/meeting-pickup';
import { MEETING_SPECIAL_CATEGORY_CLAUSE, buildMeetingMinutesPrompt, FORM_CHANNEL_BLOCK } from '../src/utils/meeting-minutes';
import { BOT_CHANNEL_BLOCK } from '../src/utils/meeting-bot';
import { BOT_TILE_NOT_RECORDING_JPEG_B64, BOT_TILE_RECORDING_JPEG_B64 } from '../src/utils/meeting-bot-tile-data';
import { specialCategoryClauseFor, withSpecialCategoryClause } from '../src/utils/special-category-clause';
import { DEFAULT_TASK_WEIGHTS } from '../src/config/task-weights';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); passed++; } catch (err) { console.error(`✗ ${name}`); throw err; }
};
const read = (p: string) => readFileSync(p, 'utf8');
const T0 = new Date('2026-11-19T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

(async () => {

// ── Links, region, words ─────────────────────────────────────────────────────────────────────────

await test('meeting links: Meet, Teams (work and personal) and Zoom are recognised; look-alikes and non-https are refused', () => {
    assert.equal(botPlatformOf('https://meet.google.com/xtt-xerh-qte'), 'google_meet');
    assert.equal(botPlatformOf('https://teams.microsoft.com/meet/384435948575539?p=abc'), 'teams');
    assert.equal(botPlatformOf('https://teams.live.com/meet/9123456'), 'teams');
    assert.equal(botPlatformOf('https://us02web.zoom.us/j/123456789?pwd=x'), 'zoom');
    assert.equal(botPlatformOf('http://meet.google.com/xtt-xerh-qte'), null);
    assert.equal(botPlatformOf('https://meet.google.com.evil.example/xtt-xerh-qte'), null);
    assert.equal(botPlatformOf('https://evil.example/meet.google.com/xtt-xerh-qte'), null);
    assert.equal(botPlatformOf('https://user:pw@meet.google.com/xtt-xerh-qte'), null);
    assert.equal(botPlatformOf('https://meet.google.com/'), null);
    assert.equal(botPlatformOf('https://zoom.us/pricing'), null);
    const bad = cleanMeetingLink('see you at 2');
    assert.ok(!bad.ok && /Google Meet, Microsoft Teams or Zoom/.test(bad.error));
    const good = cleanMeetingLink('  https://meet.google.com/xtt-xerh-qte  ');
    assert.ok(good.ok && good.platform === 'google_meet' && good.url === 'https://meet.google.com/xtt-xerh-qte');
    assert.ok(!cleanMeetingLink(`https://meet.google.com/${'a'.repeat(600)}`).ok, 'over 500 characters');
});

await test('region: anything reading as the US is us; the UK, the EU and no country are eu (UK first)', () => {
    for (const c of ['US', 'usa', 'U.S.A.', 'United States', 'united states of america']) assert.equal(recallRegionFor(c), 'us', c);
    for (const c of ['United Kingdom', 'UK', 'Ireland', 'Germany', '', null, undefined, 'Australia']) assert.equal(recallRegionFor(c), 'eu', String(c));
});

await test('the bot\'s name and join notice name the business, and the notice fits Meet\'s 500 characters', () => {
    assert.equal(botName('Marmalade Productions'), 'Note Taker for Marmalade Productions');
    assert.equal(botName(''), 'Note Taker for this business');
    assert.ok(botName('x'.repeat(300)).length <= 100);
    const m = joinMessage('Marmalade Productions');
    assert.match(m, /Marmalade Productions's Be More Swan Note Taker/);
    assert.match(m, /transcript/);
    assert.match(m, /host can remove me/);
    assert.ok(joinMessage('y'.repeat(300)).length <= JOIN_MESSAGE_MAX);
});

await test('join time: now, under 10 minutes away = now, later = booked, over 60 days = refused', () => {
    assert.deepEqual(cleanJoinAt(null, T0), { ok: true, joinAt: T0, scheduled: false });
    const soon = cleanJoinAt(new Date(T0.getTime() + SCHEDULE_AHEAD_MS - 1000).toISOString(), T0);
    assert.ok(soon.ok && !soon.scheduled && soon.joinAt.getTime() === T0.getTime());
    const later = cleanJoinAt(at(60).toISOString(), T0);
    assert.ok(later.ok && later.scheduled && later.joinAt.getTime() === at(60).getTime());
    assert.ok(!cleanJoinAt(at(61 * 24 * 60).toISOString(), T0).ok);
    assert.ok(!cleanJoinAt('soon-ish', T0).ok);
});

await test('"join now" is stored on the minute, so two presses racing in the same minute hit the unique index (review of #769)', () => {
    const t = new Date('2026-11-19T10:07:42.318Z');
    assert.equal(immediateJoinAt(t).toISOString(), '2026-11-19T10:07:00.000Z');
    const now = cleanJoinAt(null, t);
    assert.ok(now.ok && now.joinAt.toISOString() === '2026-11-19T10:07:00.000Z');
    const soon = cleanJoinAt(new Date(t.getTime() + 60_000).toISOString(), t);
    assert.ok(soon.ok && !soon.scheduled && soon.joinAt.toISOString() === '2026-11-19T10:07:00.000Z');
});

await test('length limit: 2 hours by default, at most 4, at least 5 minutes', () => {
    assert.equal(cleanLengthLimit(undefined), 120);
    assert.equal(cleanLengthLimit(999), 240);
    assert.equal(cleanLengthLimit(1), 5);
});

// ── Charging (B3) ────────────────────────────────────────────────────────────────────────────────

await test('B3: 1 task per STARTED 5 minutes in the call; nothing when never in it; the reserve covers the whole limit', () => {
    assert.equal(DEFAULT_TASK_WEIGHTS.meeting_bot_call, 1);
    assert.equal(chargeUnits(0, 1), 0, 'never let in');
    assert.equal(chargeUnits(1, 1), 1);
    assert.equal(chargeUnits(5, 1), 1);
    assert.equal(chargeUnits(6, 1), 2);
    assert.equal(chargeUnits(60, 1), 12, 'a 1-hour meeting is 12 tasks (Terms 2.5 draft)');
    assert.equal(chargeUnits(60, 0), 0, 'a weight of 0 charges nothing');
    assert.equal(reserveUnits(120, 1), 24);
    assert.equal(minutesInCall(at(0), at(0.5)), 1, 'rounded up');
    assert.equal(minutesInCall(null, at(3)), 0);
});

// ── States ───────────────────────────────────────────────────────────────────────────────────────

function run(events: [string, string | null, number][], start: BotStatus = 'joining') {
    let row: BotStateRow & { reason?: string | null; minutes?: number | null } = { status: start, joinedAt: null, leftAt: null };
    for (const [code, sub, min] of events) {
        const p = nextBotState(row, code, sub, at(min));
        if (p) row = { status: p.status, joinedAt: p.joinedAt, leftAt: p.leftAt, statusReason: p.statusReason, reason: p.statusReason, minutes: p.minutesInCall ?? row.minutes };
    }
    return row;
}

await test('a normal call: joining → waiting room → in the call → ended → done, minutes counted from joining to leaving', () => {
    const r = run([['joining_call', null, 0], ['in_waiting_room', null, 0.2], ['in_call_recording', null, 1], ['call_ended', 'call_ended_by_host', 31], ['done', null, 32]]);
    assert.equal(r.status, 'done');
    assert.equal(r.joinedAt?.getTime(), at(1).getTime());
    assert.equal(r.leftAt?.getTime(), at(31).getTime(), 'left when the call ended, not when Recall finished');
    assert.equal(r.minutes, 30);
});

await test('never let in: waiting room then the timeout is not_admitted, and a later done changes nothing', () => {
    const r = run([['in_waiting_room', null, 0], ['call_ended', 'timeout_exceeded_waiting_room', 10], ['done', null, 11]]);
    assert.equal(r.status, 'not_admitted');
    assert.equal(r.joinedAt, null);
    assert.equal(r.minutes ?? 0, 0);
});

await test('fatal before joining: waiting-room reasons are not_admitted, removals removed, anything else failed', () => {
    assert.equal(run([['fatal', 'bot_kicked_from_waiting_room', 1]]).status, 'not_admitted');
    assert.equal(run([['fatal', 'meeting_not_found', 1]]).status, 'failed');
    assert.equal(run([['fatal', 'bot_kicked_from_call', 1]]).status, 'removed');
});

await test('fatal or removal after joining still writes up what was heard', () => {
    const r = run([['in_call_recording', null, 1], ['fatal', 'bot_errored', 11]]);
    assert.equal(r.status, 'done');
    assert.equal(r.minutes, 10);
});

await test('events out of order or unknown change nothing; a final state never moves back', () => {
    const r = run([['in_call_recording', null, 1], ['in_waiting_room', null, 2], ['joining_call', null, 3], ['some_new_code', null, 4]]);
    assert.equal(r.status, 'in_call');
    assert.equal(nextBotState({ status: 'cancelled', joinedAt: null, leftAt: null }, 'in_call_recording', null, at(5)), null);
    assert.equal(nextBotState({ status: 'done', joinedAt: at(1), leftAt: at(9) }, 'done', null, at(10)), null);
});

await test('removed by the host after joining: still done (what it heard is written up), and the reason is kept through done', () => {
    const r = run([['in_call_recording', null, 1], ['call_ended', 'bot_kicked_from_call', 21], ['done', null, 22]]);
    assert.equal(r.status, 'done');
    assert.equal(r.reason, 'bot_kicked_from_call');
    assert.equal(r.minutes, 20);
});

await test('review round 3: the poll replays EVERY change, so a recorded call whose webhooks were all missed is not lost', () => {
    const changes = [
        { code: 'done', subCode: null, at: at(32) },               // out of order on purpose: replay sorts by time
        { code: 'joining_call', subCode: null, at: at(0) },
        { code: 'in_call_recording', subCode: null, at: at(1) },
        { code: 'call_ended', subCode: 'call_ended_by_host', at: at(31) },
    ];
    const p = replayBotState({ status: 'joining', joinedAt: null, leftAt: null }, changes);
    assert.ok(p);
    assert.equal(p!.status, 'done', 'not "failed / never_joined"');
    assert.equal(p!.joinedAt?.getTime(), at(1).getTime());
    assert.equal(p!.leftAt?.getTime(), at(31).getTime());
    assert.equal(p!.minutesInCall, 30);
    assert.equal(p!.statusReason, 'call_ended_by_host');
    // Only the last change (the old way) would have lost it:
    assert.equal(nextBotState({ status: 'joining', joinedAt: null, leftAt: null }, 'done', null, at(32))?.status, 'failed');
    assert.equal(replayBotState({ status: 'in_call', joinedAt: at(1), leftAt: null }, [{ code: 'in_call_recording', subCode: null, at: at(1) }]), null, 'nothing moved');
});

await test('done without call_ended uses Recall\'s time as the leaving time', () => {
    const r = run([['in_call_recording', null, 2], ['done', null, 12]]);
    assert.equal(r.status, 'done');
    assert.equal(r.minutes, 10);
});

// ── The request to Recall ────────────────────────────────────────────────────────────────────────

await test('the Recall request: platform speaker names, Recall\'s transcript, the pinned notice, auto-leave, string metadata', () => {
    const base = { meetingUrl: 'https://meet.google.com/xtt-xerh-qte', businessName: 'Marmalade', joinAt: at(30), lengthLimitMinutes: 90, botRowId: 7, organisationId: 58 };
    const now = recallBotRequest({ ...base, scheduled: false }) as Record<string, any>;
    assert.equal(now.join_at, undefined, 'joins straight away');
    const later = recallBotRequest({ ...base, scheduled: true }) as Record<string, any>;
    assert.equal(later.join_at, at(30).toISOString());
    assert.equal(now.bot_name, 'Note Taker for Marmalade');
    assert.deepEqual(now.chat.on_bot_join, { send_to: 'everyone', message: joinMessage('Marmalade'), pin: true });
    assert.ok(now.recording_config.transcript.provider.recallai_streaming, 'B2: Recall\'s own transcript');
    assert.equal(now.recording_config.transcript.diarization.use_separate_streams_when_available, true, 'names from the platform');
    assert.equal(now.automatic_leave.waiting_room_timeout, WAITING_ROOM_TIMEOUT_S);
    assert.equal(now.automatic_leave.everyone_left_timeout.timeout, ALONE_TIMEOUT_S);
    assert.equal(now.automatic_leave.in_call_recording_timeout, 90 * 60, 'the length limit, in seconds');
    assert.deepEqual(now.metadata, { bms_bot_id: '7', bms_org_id: '58' });
});

await test('the bot\'s video tile: a JPEG for recording and one for not recording, inside Recall\'s 1.3 MB limit', () => {
    const base = { meetingUrl: 'https://meet.google.com/xtt-xerh-qte', businessName: 'Marmalade', joinAt: at(0), scheduled: false, lengthLimitMinutes: 60, botRowId: 1, organisationId: 1 };
    assert.equal((recallBotRequest(base) as Record<string, any>).automatic_video_output, undefined, 'no tile passed, no field');
    const req = recallBotRequest({ ...base, videoTile: { recordingJpegB64: BOT_TILE_RECORDING_JPEG_B64, notRecordingJpegB64: BOT_TILE_NOT_RECORDING_JPEG_B64 } }) as Record<string, any>;
    for (const state of ['in_call_recording', 'in_call_not_recording']) {
        const out = req.automatic_video_output[state];
        assert.equal(out.kind, 'jpeg', state);
        const jpg = Buffer.from(out.b64_data, 'base64');
        assert.equal(jpg.toString('base64'), out.b64_data, `${state}: standard base64, no data: prefix`);
        assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], `${state}: a JPEG`);
        assert.ok(jpg.length < 1_300_000, `${state}: under 1.3 MB`);
        // 1280×720 (16:9): read the SOF0/SOF2 frame header.
        let i = 2, size: number[] | null = null;
        while (i < jpg.length) {
            const marker = jpg[i + 1], len = jpg.readUInt16BE(i + 2);
            if (marker === 0xc0 || marker === 0xc2) { size = [jpg.readUInt16BE(i + 7), jpg.readUInt16BE(i + 5)]; break; }
            i += 2 + len;
        }
        assert.deepEqual(size, [1280, 720], `${state}: 1280×720`);
    }
    assert.notEqual(req.automatic_video_output.in_call_recording.b64_data, req.automatic_video_output.in_call_not_recording.b64_data, 'two different pictures');
});

await test('the tile pictures load only where a bot is sent: meeting-bot.ts never imports them; sendMeetingBot imports them lazily', () => {
    assert.ok(!read('src/utils/meeting-bot.ts').includes("from './meeting-bot-tile-data'"), 'not in meeting-bot.ts (recall-webhook loads it)');
    const db = read('src/utils/meeting-bot-db.ts');
    assert.ok(!db.includes("from './meeting-bot-tile-data'"), 'no static import in meeting-bot-db.ts');
    assert.ok(db.includes("await import('./meeting-bot-tile-data')"), 'dynamic import where the bot is sent');
});

await test('Recall\'s transcript: one line per block with the participant\'s name; empty blocks dropped, no name = unlabelled', () => {
    const lines = recallTranscriptLines([
        { participant: { name: 'Alex Smith' }, words: [{ text: 'Morning' }, { text: 'all' }] },
        { participant: { name: null }, words: [{ text: 'hi' }] },
        { participant: { name: 'Sam' }, words: [] },
    ]);
    assert.deepEqual(lines, [{ speaker: 'Alex Smith', text: 'Morning all' }, { speaker: null, text: 'hi' }]);
    assert.deepEqual(recallTranscriptLines({ not: 'an array' }), []);
});

await test('bot ids in meeting_imports round-trip and only recall:<region>:<id> parses', () => {
    assert.equal(botExternalId('eu', 'b488c298-x'), 'recall:eu:b488c298-x');
    assert.deepEqual(parseBotExternalId('recall:us:abc'), { region: 'us', recallBotId: 'abc' });
    assert.equal(parseBotExternalId('conferenceRecords/abc'), null);
    assert.equal(parseBotExternalId('recall:mars:abc'), null);
});

// ── Recall's signature ───────────────────────────────────────────────────────────────────────────

const SECRET_EU = `whsec_${Buffer.from('eu-secret-bytes-0123456789').toString('base64')}`;
const SECRET_US = `whsec_${Buffer.from('us-secret-bytes-9876543210').toString('base64')}`;
function sign(secret: string, id: string, ts: string, body: string) {
    return createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
}

await test('signature: the right region is named; wrong secret, tampered body, stale timestamp or no headers are refused', () => {
    const body = '{"event":"bot.done","data":{"bot":{"id":"b1"},"data":{"code":"done"}}}';
    const ts = String(Math.floor(T0.getTime() / 1000));
    const headers = (secret: string, b = body) => ({ 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sign(secret, 'msg_1', ts, b)}` });
    assert.equal(verifyRecallSignature({ eu: SECRET_EU, us: SECRET_US }, headers(SECRET_EU), body, T0), 'eu');
    assert.equal(verifyRecallSignature({ eu: SECRET_EU, us: SECRET_US }, headers(SECRET_US), body, T0), 'us');
    assert.equal(verifyRecallSignature({ eu: SECRET_EU }, headers(SECRET_US), body, T0), null, 'a region we have no secret for');
    assert.equal(verifyRecallSignature({ eu: SECRET_EU }, headers(SECRET_EU), body.replace('done', 'fatal'), T0), null, 'tampered');
    assert.equal(verifyRecallSignature({ eu: SECRET_EU }, headers(SECRET_EU), body, new Date(T0.getTime() + 6 * 60_000)), null, 'stale');
    assert.equal(verifyRecallSignature({ eu: SECRET_EU }, {}, body, T0), null);
    // During a rotation several v1 signatures arrive; any one valid is enough. Older accounts send svix-* headers.
    const multi = { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,AAAA v1,${sign(SECRET_EU, 'msg_1', ts, body)}` };
    assert.equal(verifyRecallSignature({ eu: SECRET_EU }, multi, body, T0), 'eu');
    const svix = { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sign(SECRET_EU, 'msg_1', ts, body)}` };
    assert.equal(verifyRecallSignature({ eu: SECRET_EU }, svix, body, T0), 'eu');
});

// ── The hand-over to the meeting pick-up engine ──────────────────────────────────────────────────

const transcriptSource = (platform: 'google_meet' | 'teams'): MeetingSource => ({
    platform, async accounts() { return []; }, async account() { return null; }, async listFinished() { return []; }, async fetchTranscript() { return null; },
});

await test('sourceFor: a bot meeting goes to the bot source whatever its platform; a picked-up one to its platform\'s', () => {
    const meet = transcriptSource('google_meet');
    const bot: MeetingSource = { ...transcriptSource('google_meet'), via: 'bot' };
    const sources = [meet, bot];
    assert.equal(sourceFor(sources, { platform: 'google_meet', via: 'bot' }), bot);
    assert.equal(sourceFor(sources, { platform: 'teams', via: 'bot' }), bot);
    assert.equal(sourceFor(sources, { platform: 'google_meet' }), meet, 'absent via = transcript');
    assert.equal(sourceFor(sources, { platform: 'teams', via: 'transcript' }), undefined, 'no Teams pick-up yet');
});

await test('writeImport on a bot meeting: capacity and charge see the row, and the card says the Note Taker joined', async () => {
    const row: ImportRow = { id: 5, organisationId: 58, assistantId: 21, platform: 'teams', externalId: 'recall:eu:b1', title: 'Weekly', link: 'https://teams.microsoft.com/meet/1', startedAt: at(0), endedAt: at(30), attempts: 1, via: 'bot' };
    const released: ImportRelease[] = [];
    let latched = false;
    const store: PickupStore = {
        async checkedThrough() { return null; }, async saveCheck() {}, async addFound() { return 0; }, async due() { return []; },
        async claim() { return row; }, async release(_id, r) { released.push(r); }, async markWritten() { latched = true; return true; },
    };
    const seen: { capacityVia?: string; chargeVia?: string; card?: Record<string, unknown> } = {};
    const bot: MeetingSource = {
        ...transcriptSource('google_meet'), via: 'bot',
        async account(org) { return { organisationId: org, assistantId: 0, platform: 'google_meet' }; },
        async fetchTranscript() { return { lines: [{ speaker: 'Alex', text: 'We ship Friday.' }], attendees: ['Alex'] }; },
    };
    const deps: WriterDeps = {
        store, sources: [transcriptSource('google_meet'), bot], now: () => at(31),
        async assistant() { return { id: 21, name: 'Note Taker', onboardingContext: {} }; },
        async hasCapacity(_org, r) { seen.capacityVia = r.via; return true; },
        async blocked() { return false; },
        async writeMinutes() { return { ok: true, model: 'm', card: { type: 'action_item_assignment', meetingTitle: 'Weekly', meetingSummary: 's', decisionsMade: [], identifiedRisks: [], targetDestination: 'x', attendees: [], followupEmail: null, tasks: [] } as never }; },
        async file(_org, _a, card) { seen.card = card; return 900; },
        async charge(_org, _a, _id, r) { seen.chargeVia = r.via; },
    };
    assert.equal(await writeImport(5, deps), 'written');
    assert.ok(latched);
    assert.equal(seen.capacityVia, 'bot');
    assert.equal(seen.chargeVia, 'bot');
    assert.deepEqual((seen.card?.pickedUpFrom as Record<string, unknown>)?.via, 'bot');
    assert.equal((seen.card?.pickedUpFrom as Record<string, unknown>)?.label, 'Microsoft Teams');
    assert.equal(released.length, 0);
});

// ── Special category data (DPA 1.2 clause 13, legal drafts §9) ───────────────────────────────────

await test('review round 4: the Note Taker\'s special-category clause reaches ONLY bot meetings (DPA 1.2); chat and pasted meetings keep the DPA 1.1 rule', () => {
    const p = buildMeetingMinutesPrompt({ meetingPlatform: undefined, taskDestination: undefined, summaryFormat: undefined, channelBlock: FORM_CHANNEL_BLOCK });
    assert.ok(!p.includes(MEETING_SPECIAL_CATEGORY_CLAUSE), 'not in the shared prompt');
    assert.ok(BOT_CHANNEL_BLOCK.includes(MEETING_SPECIAL_CATEGORY_CLAUSE), 'in the bot\'s channel block');
    const general = 'GENERAL: I cannot process sensitive personal information.';
    assert.equal(specialCategoryClauseFor('meeting_note_taker', general), general, 'chat keeps the general rule until DPA 1.2 is published');
    assert.equal(withSpecialCategoryClause(`Prompt\n\n<!-- special-category-clause -->\n${general}`, 'meeting_note_taker', general).includes(general), true);
    assert.match(read('src/utils/meeting-pickup-db.ts'), /channelBlock: row\.via === 'bot' \? BOT_CHANNEL_BLOCK : PICKUP_CHANNEL_BLOCK/);
});

await test('review round 4: only a real deletion counts; bots go before every workspace deletion; Remove waits for an in-flight send; the poll has a budget', () => {
    const rc = read('src/utils/meeting-bot-recall.ts');
    const del = rc.slice(rc.indexOf('export async function deleteRecallMedia'));
    assert.ok(!/409/.test(del.slice(del.indexOf('{'))), '409 is not "deleted"');
    const ud = read('src/utils/user-deletion.ts');
    const fn = ud.slice(ud.indexOf('export async function deleteUserAndSoleOrgs'));
    assert.ok(fn.indexOf('withdrawBotsForDoomedOrgs(db, userId)') < fn.indexOf('db.transaction('), 'withdrawn before the transaction');
    const bot = read('src/utils/meeting-bot-db.ts');
    const rm = bot.slice(bot.indexOf('export async function removeMeetingBot'));
    assert.ok(rm.indexOf("status: 409, error: 'The Note Taker is still being sent.") < rm.indexOf('removeRecallBot('));
    const send = bot.slice(bot.indexOf('export async function sendMeetingBot'), bot.indexOf('// ── Listing and removing'));
    assert.ok(send.includes('.where(and(eq(meetingBots.id, row.id), inArray(meetingBots.status, [...OPEN_BOT_STATUSES]))).returning();'), 'the id is saved only onto an open row');
    assert.ok(send.indexOf('if (!saved) {') < send.lastIndexOf('removeRecallBot(region, recallBotId, true)'), 'and the bot withdrawn otherwise');
    assert.match(bot, /export const BOT_POLL_BUDGET_MS = 10_000;/); // 15 → 12 → 10 s with media's and imports' own windows (review of #774)
    assert.ok(bot.includes('runBatchesWithinBudget(open, POLL_BATCH, budgetMs, POLL_CALL_TIMEOUT_MS, pollOne)'));
});

// ── Safety order (source scans) ──────────────────────────────────────────────────────────────────

await test('sendMeetingBot checks the flag, the assistant, DPA 1.2, the link and the allowance BEFORE anything reaches Recall', () => {
    const src = read('src/utils/meeting-bot-db.ts');
    const fn = src.slice(src.indexOf('export async function sendMeetingBot'), src.indexOf('// ── Listing and removing'));
    const pos = (s: string) => { const i = fn.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
    const recall = pos('createRecallBot(');
    for (const before of ['MEETING_BOT_FLAG', "roleKey !== 'meeting_note_taker'", 'hasAcceptedBotDpa(', 'cleanMeetingLink(', 'hasTaskCapacity(', 'db.insert(meetingBots)']) {
        assert.ok(pos(before) < recall, `${before} comes before Recall`);
    }
    assert.match(src, /export const BOT_DPA_VERSIONS = \['1\.2'\];/, 'only DPA 1.2 covers meetings the Note Taker joins');
    // Review of #769: "now" looks back only, so a recurring link's future booking never blocks today's call.
    assert.ok(fn.includes('lte(meetingBots.joinAt, new Date(now.getTime() + SCHEDULE_AHEAD_MS))'), 'the immediate check sees a booking about to join, not next week\'s');
    // Review round 2: the index and the conflict target cover OPEN bots only, so a cancelled or refused bot never blocks re-booking.
    assert.ok(fn.includes('where: OPEN_BOT_SQL })'));
    assert.match(read('db/z-meeting-bots.sql'), /meeting_bots_org_url_join_open_uq ON meeting_bots \(organisation_id, meeting_url, join_at\)\s+WHERE status IN \('scheduled', 'joining', 'waiting_room', 'in_call', 'ended'\);/);
    assert.ok(!/meeting_bots_org_url_join_uq\b/.test(read('db/z-meeting-bots.sql')), 'no full (non-partial) index');
    // The region is the workspace owner's, never the sender's.
    assert.ok(fn.includes('regionFor(db, i.organisationId)'));
    assert.match(src, /eq\(userOrganisations\.role, 'owner'\)/);
    // A bot Recall accepted but whose id we couldn't save is withdrawn, not left untracked.
    assert.ok(fn.indexOf('removeRecallBot(region, recallBotId, true)') > recall, 'withdrawn after a failed save');
});

await test('cancel marks a bot cancelled only when Recall deleted it; a bot already on its way in is asked to leave and its events decide', () => {
    const src = read('src/utils/meeting-bot-db.ts');
    const fn = src.slice(src.indexOf('export async function removeMeetingBot'), src.indexOf('// ── Recall\'s events'));
    assert.ok(fn.includes("if (how !== 'deleted') return { ok: true, bot: botView(row) };"));
    assert.ok(fn.indexOf("how !== 'deleted'") < fn.indexOf("status: 'cancelled'"));
    const rc = read('src/utils/meeting-bot-recall.ts');
    assert.match(rc, /Promise<'deleted' \| 'left' \| null>/);
    // A member limited to other assistants can't remove this Note Taker's bots by id (review round 2).
    assert.ok(fn.includes('canAccessAssistant(access, row.aiAssistantId)'));
    const ep = read('netlify/functions/meeting-bots.ts');
    assert.ok(ep.includes('removeMeetingBot(db, organisationId, botId, assistantAccess)'));
    assert.equal((ep.match(/canAccessAssistant\(assistantAccess, assistantId\)/g) ?? []).length, 2, 'list and send check access too');
});

await test('the endpoint sends only through sendMeetingBot; the webhook fails closed and verifies before it parses', () => {
    const ep = read('netlify/functions/meeting-bots.ts');
    assert.ok(ep.includes('sendMeetingBot(db,') && ep.includes('requireTenant(event, db)'));
    assert.ok(!ep.includes('createRecallBot'), 'never calls Recall directly');
    const wh = read('netlify/functions/recall-webhook.ts');
    assert.ok(wh.indexOf("return json(503") < wh.indexOf('verifyRecallSignature('), 'no secret set → refuse first');
    assert.ok(wh.indexOf('verifyRecallSignature(') < wh.indexOf('JSON.parse(raw)'), 'signature before parsing');
    assert.ok(!/console\.log\([^)]*(transcript|title|name)/i.test(wh), 'logs ids and codes only');
});

await test('Recall is reached from one file only, and the flag ships OFF', () => {
    for (const f of ['src/utils/meeting-bot-db.ts', 'netlify/functions/meeting-bots.ts', 'netlify/functions/recall-webhook.ts', 'src/utils/meeting-pickup-db.ts']) {
        assert.ok(!read(f).includes('recall.ai/api'), `${f} must go through meeting-bot-recall.ts`);
    }
    assert.equal(MEETING_BOT_FLAG, 'meeting_bot');
    const sql = read('db/z-meeting-bots.sql');
    assert.match(sql, /VALUES \('meeting_bot', FALSE, 0, NULL,/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'transcript'/);
});

await test('review round 3: the poll replays all changes and moves a failing bot to the back of the queue', () => {
    const src = read('src/utils/meeting-bot-db.ts');
    const poll = src.slice(src.indexOf('export async function pollMeetingBots'), src.indexOf('export async function withdrawMeetingBots'));
    assert.ok(poll.includes('replayBotState(') && poll.includes('bot.changes'));
    const katch = poll.slice(poll.indexOf('} catch (err) {'));
    assert.ok(katch.indexOf('updatedAt: now') >= 0 && katch.indexOf('updatedAt: now') < katch.indexOf('console.error'), 'bumped before logging');
    assert.match(read('src/utils/meeting-bot-recall.ts'), /changes: all,/);
});

await test('review round 3: bots are withdrawn on archive, purge and workspace deletion; a purge keeps the bot rows', () => {
    const arch = read('netlify/functions/manage-assistant.ts');
    assert.ok(arch.indexOf('withdrawMeetingBots(db, orgId, [id])') > arch.indexOf('await db.delete(taskRuns)'), 'archive withdraws');
    const purge = read('netlify/functions/purge-archived-assistants.ts');
    assert.ok(purge.indexOf('withdrawMeetingBots(db, orgId, assistantIds)') < purge.indexOf('await db.delete(aiAssistants)'), 'before the delete');
    const del = read('netlify/functions/account-delete-execute.ts');
    assert.ok(del.indexOf('withdrawMeetingBots(db, user.organisationId)') < del.indexOf('await db.delete(organisations)'), 'before the cascade');
    assert.match(read('db/z-meeting-bots-assistant-set-null.sql'), /REFERENCES ai_assistants\(id\) ON DELETE SET NULL;/);
    assert.match(read('db/z-meeting-bots.sql'), /ai_assistant_id\s+INTEGER REFERENCES ai_assistants\(id\) ON DELETE SET NULL/);
    const schema = read('db/schema.ts');
    const bots = schema.slice(schema.indexOf('export const meetingBots = pgTable'), schema.indexOf('export const meetingBots = pgTable') + 900);
    assert.ok(bots.includes('aiAssistantId: integer("ai_assistant_id").references(() => aiAssistants.id, { onDelete: "set null" })'));
});

await test('the charge happens after the latch and deletes Recall\'s copy; bot meetings skip the second capacity check', () => {
    const db = read('src/utils/meeting-pickup-db.ts');
    assert.match(db, /if \(row\.via === 'bot'\) return true;/);
    assert.match(db, /if \(row\.via === 'bot'\) return chargeBotMeeting\(/);
    const bot = read('src/utils/meeting-bot-db.ts');
    const charge = bot.slice(bot.indexOf('export async function chargeBotMeeting'));
    assert.ok(charge.indexOf('recordCompletedWork(') < charge.indexOf('deleteBotMedia('), 'charged, then the recording deleted');
});

console.log(`meeting-bot: ${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
