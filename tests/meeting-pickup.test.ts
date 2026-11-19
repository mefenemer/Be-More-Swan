// Meeting pick-up engine (docs/meeting-apps-pickup-plan.md §2): a fake platform and an in-memory store drive
// discoverMeetings + writeImport through every outcome. Run: npx tsx tests/meeting-pickup.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    CHECK_OVERLAP_MS, FIRST_LOOKBACK_MS, MAX_ATTEMPTS, TASK_LIMIT_WAIT_MS, MEETING_PICKUP_FLAG, PICKUP_CHANNEL_BLOCK, TRANSCRIPT_WAIT_MS,
    checkWindowStart, discoverMeetings, pickedUpFrom, pickupMessage, speakerLines, transcriptRetryAt, writeImport,
    type FinishedMeeting, type ImportRelease, type ImportRow, type MeetingSource, type PickedTranscript,
    type PickupAccount, type PickupPlatform, type PickupStore, type WriterDeps,
} from '../src/utils/meeting-pickup';
import type { WriteMinutesResult } from '../src/utils/meeting-minutes-writer';
import { DEFAULT_TASK_WEIGHTS } from '../src/config/task-weights';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; void name; };

// ── In-memory store ──────────────────────────────────────────────────────────────────────────────
type Row = ImportRow & { status: string; skipReason?: string; lastError?: string | null; leaseUntil: Date | null; recordId?: number };
function memStore() {
    const rows = new Map<number, Row>();
    const state = new Map<string, { through: Date | null; error: string | null; found: number }>();
    let next = 1;
    const store: PickupStore = {
        async checkedThrough(o, p) { return state.get(`${o}:${p}`)?.through ?? null; },
        async saveCheck(o, p, s) {
            const prev = state.get(`${o}:${p}`);
            state.set(`${o}:${p}`, { through: s.through ?? prev?.through ?? null, error: s.error, found: s.found });
        },
        async addFound(a, ms) {
            let added = 0;
            for (const m of ms) {
                if ([...rows.values()].some((r) => r.organisationId === a.organisationId && r.platform === a.platform && r.externalId === m.externalId)) continue;
                const id = next++;
                rows.set(id, { id, organisationId: a.organisationId, assistantId: a.assistantId, platform: a.platform, externalId: m.externalId,
                    title: m.title ?? null, link: m.link ?? null, startedAt: m.startedAt ?? null, endedAt: m.endedAt, attempts: 0, status: 'found', leaseUntil: null });
                added++;
            }
            return added;
        },
        async due(now) {
            return [...rows.values()].filter((r) => (r.status === 'found' || r.status === 'writing') && (!r.leaseUntil || r.leaseUntil < now)
                && r.endedAt && r.endedAt.getTime() < now.getTime() - 2 * 60 * 1000).map((r) => r.id);
        },
        async claim(id, now) {
            const r = rows.get(id);
            if (!r || !(r.status === 'found' || r.status === 'writing') || (r.leaseUntil && r.leaseUntil >= now)) return null;
            r.status = 'writing'; r.leaseUntil = new Date(now.getTime() + 20 * 60 * 1000); r.attempts++;
            return { ...r };
        },
        async release(id, rel: ImportRelease) {
            const r = rows.get(id)!;
            if (r.status !== 'writing') return;
            r.status = rel.status;
            if (rel.status === 'found') { r.leaseUntil = rel.retryAt ?? null; r.lastError = rel.lastError ?? null; if (rel.refundAttempt) r.attempts = Math.max(r.attempts - 1, 0); }
            else if (rel.status === 'skipped') { r.skipReason = rel.skipReason; r.leaseUntil = null; }
            else { r.lastError = rel.lastError; r.leaseUntil = null; }
        },
        async markWritten(id, recordId) {
            const r = rows.get(id)!;
            if (r.status !== 'writing') return false;
            r.status = 'written'; r.recordId = recordId; r.leaseUntil = null;
            return true;
        },
    };
    return { store, rows, state };
}

// ── A fake platform ──────────────────────────────────────────────────────────────────────────────
const T0 = new Date('2026-11-19T10:00:00Z');
const acct: PickupAccount = { organisationId: 58, assistantId: 66, platform: 'google_meet', ref: { connectionId: 9 } };
function fakeSource(o: { meetings?: FinishedMeeting[]; transcript?: PickedTranscript | null; listThrows?: boolean; connected?: boolean } = {}): MeetingSource & { listCalls: Date[] } {
    const src = {
        platform: 'google_meet' as PickupPlatform,
        listCalls: [] as Date[],
        async accounts() { return [acct]; },
        async account() { return o.connected === false ? null : acct; },
        async listFinished(_a: PickupAccount, since: Date) {
            src.listCalls.push(since);
            if (o.listThrows) throw new Error('403 from platform');
            return o.meetings ?? [];
        },
        async fetchTranscript() { return o.transcript === undefined ? GOOD : o.transcript; },
    };
    return src;
}
const GOOD: PickedTranscript = {
    lines: [
        { speaker: 'Ana Lopez', text: 'We go with vendor A.' },
        { speaker: 'Ana Lopez', text: 'Bo, send the contract by Friday.' },
        { speaker: 'Bo Chen', text: 'Will do. Legal may be slow.' },
    ],
    attendees: ['Ana Lopez', 'Bo Chen', 'Cara (silent)'],
};
const CARD = { type: 'meeting_minutes', meetingTitle: 'Vendor call', meetingSummary: '• Vendor A.', tasks: [{ description: 'Send the contract', assignee: 'Bo Chen', dueDate: 'Friday' }] };

function deps(store: PickupStore, source: MeetingSource, over: Partial<WriterDeps> = {}) {
    const log = { written: [] as string[], filed: [] as Record<string, unknown>[], charged: [] as number[], capacityAsked: 0 };
    const d: WriterDeps = {
        store, sources: [source], now: () => new Date(T0.getTime() + 30 * 60 * 1000),
        async assistant(o, a) { return o === 58 && a === 66 ? { id: 66, name: 'Cosmo Quill', onboardingContext: {} } : null; },
        async hasCapacity() { log.capacityAsked++; return true; },
        async blocked() { return false; },
        async writeMinutes(_o, _a, message): Promise<WriteMinutesResult> { log.written.push(message); return { ok: true, card: CARD as never, model: 'claude-haiku-5-5' }; },
        async file(_o, _a, card, importId) {
            const prev = log.filed.findIndex((c) => (c.pickedUpFrom as { importId?: number })?.importId === importId);
            if (prev >= 0) return 901 + prev;
            log.filed.push(card); return 900 + log.filed.length;
        },
        async charge(_o, _a, id) { log.charged.push(id); },
        ...over,
    };
    return { d, log };
}
const meeting = (id: string, endedMinAgo = 30): FinishedMeeting => ({
    externalId: id, title: 'Vendor call', link: 'https://meet.google.com/abc-defg-hij',
    startedAt: new Date(T0.getTime() - 30 * 60 * 1000), endedAt: new Date(T0.getTime() + 30 * 60 * 1000 - endedMinAgo * 60 * 1000),
});

(async () => {
// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────
await test('speakerLines joins back-to-back lines and names unknown speakers', () => {
    assert.deepEqual(speakerLines([
        { speaker: 'Ana', text: ' Hello. ' }, { speaker: 'Ana', text: 'Second.' }, { speaker: null, text: 'Who am I' },
        { speaker: 'Bo', text: '   ' }, { speaker: 'Bo', text: 'Hi\n there' },
    ]), ['Ana: Hello. Second.', 'Unknown speaker: Who am I', 'Bo: Hi there']);
});

await test('pickupMessage names the platform, time, attendees and fences the transcript', () => {
    const m = pickupMessage({ platform: 'google_meet', title: '', startedAt: new Date('2026-11-19T04:10:19Z'), attendees: ['Ana', 'Ana', ' Bo '], lines: ['Ana: Hi'] });
    assert.equal(m, 'Meeting on Google Meet: Google Meet call, 2026-11-19 04:10 UTC\nPresent: Ana, Bo\n<<<TRANSCRIPT\nAna: Hi\nTRANSCRIPT>>>');
    assert.match(PICKUP_CHANNEL_BLOCK, /picked up automatically/);
});

await test('pickedUpFrom keeps only https links', () => {
    assert.equal(pickedUpFrom('zoom', 1, 'javascript:alert(1)').link, null);
    assert.equal(pickedUpFrom('teams', 1, 'https://teams.microsoft.com/l/x').label, 'Microsoft Teams');
});

await test('the check window: 24 h on first connect, then from the last check less the overlap', () => {
    assert.equal(checkWindowStart(null, T0).getTime(), T0.getTime() - FIRST_LOOKBACK_MS);
    const last = new Date(T0.getTime() - 15 * 60 * 1000);
    assert.equal(checkWindowStart(last, T0).getTime(), last.getTime() - CHECK_OVERLAP_MS);
});

await test('transcript retries back off, then give up after 24 h', () => {
    const now = T0;
    const r1 = transcriptRetryAt(new Date(now.getTime() - 5 * 60 * 1000), now)!;
    assert.equal(r1.getTime() - now.getTime(), 10 * 60 * 1000);
    const r2 = transcriptRetryAt(new Date(now.getTime() - 20 * 60 * 60 * 1000), now)!;
    assert.equal(r2.getTime() - now.getTime(), 6 * 60 * 60 * 1000);
    assert.equal(transcriptRetryAt(new Date(now.getTime() - TRANSCRIPT_WAIT_MS), now), null);
});

// ── discoverMeetings ─────────────────────────────────────────────────────────────────────────────
await test('a meeting seen twice is one row', async () => {
    const { store, rows, state } = memStore();
    const src = fakeSource({ meetings: [meeting('conferenceRecords/a'), meeting('conferenceRecords/b')] });
    const r1 = await discoverMeetings(store, [src], T0);
    const r2 = await discoverMeetings(store, [src], new Date(T0.getTime() + 15 * 60 * 1000));
    assert.deepEqual([r1.found, r2.found, rows.size], [2, 0, 2]);
    assert.equal(src.listCalls[1].getTime(), T0.getTime() - CHECK_OVERLAP_MS, 'second check starts at the first one less the overlap');
    assert.equal(state.get('58:google_meet')!.error, null);
});

await test('checks that keep failing from the start keep the first window start', async () => {
    const { store } = memStore();
    const bad = fakeSource({ listThrows: true });
    await discoverMeetings(store, [bad], T0);
    await discoverMeetings(store, [bad], new Date(T0.getTime() + 48 * 60 * 60 * 1000));
    assert.equal(bad.listCalls[1].getTime(), T0.getTime() - FIRST_LOOKBACK_MS - CHECK_OVERLAP_MS, 'day 3 still looks back to the first window');
});

await test('a failed check keeps the window where it was and records the error', async () => {
    const { store, state } = memStore();
    await discoverMeetings(store, [fakeSource()], T0);
    const r = await discoverMeetings(store, [fakeSource({ listThrows: true })], new Date(T0.getTime() + 15 * 60 * 1000));
    assert.equal(r.errors, 1);
    assert.equal(state.get('58:google_meet')!.through!.getTime(), T0.getTime());
    assert.match(state.get('58:google_meet')!.error!, /403/);
});

await test('Google Meet is the one platform, behind the meeting_pickup flag (plus the Note Taker\'s own bot)', () => {
    assert.equal(MEETING_PICKUP_FLAG, 'meeting_pickup');
    assert.match(readFileSync('src/utils/meeting-pickup-db.ts', 'utf8'), /return \[googleMeetSource\(db\), meetingBotSource\(db\)\];/);
});

// ── writeImport ──────────────────────────────────────────────────────────────────────────────────
async function oneFound(src = fakeSource({ meetings: [meeting('conferenceRecords/a')] })) {
    const m = memStore();
    await discoverMeetings(m.store, [src], T0);
    return { ...m, src, id: [...m.rows.keys()][0] };
}

await test('happy path: written, filed with where it came from, charged once after the latch', async () => {
    const { store, rows, src, id } = await oneFound();
    const { d, log } = deps(store, src);
    assert.equal(await writeImport(id, d), 'written');
    assert.equal(rows.get(id)!.status, 'written');
    assert.equal(rows.get(id)!.recordId, 901);
    assert.deepEqual(log.charged, [id]);
    assert.match(log.written[0], /^Meeting on Google Meet: Vendor call/);
    assert.match(log.written[0], /Ana Lopez: We go with vendor A\. Bo, send the contract by Friday\.\nBo Chen:/);
    assert.match(log.written[0], /Present: Ana Lopez, Bo Chen, Cara \(silent\)/);
    assert.deepEqual(log.filed[0].pickedUpFrom, { platform: 'google_meet', label: 'Google Meet', link: 'https://meet.google.com/abc-defg-hij', startedAt: '2026-11-19T09:30:00.000Z', importId: id });
    assert.equal(await writeImport(id, d), 'not_claimed', 'a written meeting is never written again');
    assert.equal(log.charged.length, 1);
});

await test('transcript not ready: waits without using an attempt, nothing charged', async () => {
    const { store, rows, id } = await oneFound();
    const src = fakeSource({ transcript: null });
    const { d, log } = deps(store, src);
    assert.equal(await writeImport(id, d), 'waiting_for_transcript');
    const r = rows.get(id)!;
    assert.deepEqual([r.status, r.attempts, log.charged.length, log.capacityAsked], ['found', 0, 0, 0]);
    assert.ok(r.leaseUntil && r.leaseUntil > d.now(), 'not due again until the back-off passes');
});

await test('no transcript after 24 h: skipped', async () => {
    const m = memStore();
    const src = fakeSource({ meetings: [meeting('conferenceRecords/old', 25 * 60)], transcript: null });
    await discoverMeetings(m.store, [src], T0);
    const { d } = deps(m.store, src);
    assert.equal(await writeImport(1, d), 'skipped_no_transcript');
    assert.equal(m.rows.get(1)!.skipReason, 'no_transcript');
});

await test('task allowance used up: kept and tried again later, model not called; given up after 7 days', async () => {
    const { store, rows, src, id } = await oneFound();
    const { d, log } = deps(store, src, { async hasCapacity() { return false; } });
    assert.equal(await writeImport(id, d), 'waiting_for_tasks');
    const r = rows.get(id)!;
    assert.deepEqual([r.status, r.attempts, r.lastError, log.written.length, log.charged.length], ['found', 0, 'task_limit', 0, 0]);
    assert.ok(r.leaseUntil && r.leaseUntil > d.now());
    const m = memStore();
    const old = fakeSource({ meetings: [meeting('conferenceRecords/week-old', TASK_LIMIT_WAIT_MS / 60000 + 60)] });
    await discoverMeetings(m.store, [old], T0);
    assert.equal(await writeImport(1, deps(m.store, old, { async hasCapacity() { return false; } }).d), 'skipped_task_limit');
    assert.equal(m.rows.get(1)!.skipReason, 'task_limit');
});

await test('a writer that died after filing: the next writer reuses that record, no second copy', async () => {
    const { store, rows, src, id } = await oneFound();
    let clock = new Date(T0.getTime() + 30 * 60 * 1000);
    let crash = true;
    const crashing: PickupStore = { ...store, async markWritten(i, rec, now) { if (crash) { crash = false; return new Promise<boolean>(() => undefined) as never; } return store.markWritten(i, rec, now); } };
    const { d, log } = deps(crashing, src, { now: () => clock });
    void writeImport(id, d); // never finishes: the worker "died" holding the lease
    await new Promise((r) => setTimeout(r, 10));
    clock = new Date(clock.getTime() + 21 * 60 * 1000);
    assert.equal(await writeImport(id, d), 'written');
    assert.deepEqual([log.filed.length, rows.get(id)!.recordId, log.charged.length], [1, 901, 1]);
});

await test('no meeting in the transcript (a sound check): skipped, not charged', async () => {
    const { store, rows, src, id } = await oneFound();
    const { d, log } = deps(store, src, { async writeMinutes() { return { ok: false, reason: 'no_meeting', reply: 'Only a sound check.' }; } });
    assert.equal(await writeImport(id, d), 'skipped_no_meeting');
    assert.deepEqual([rows.get(id)!.skipReason, log.charged.length], ['no_meeting', 0]);
});

await test('archived Note Taker or disconnected platform: skipped', async () => {
    const a = await oneFound();
    assert.equal(await writeImport(a.id, deps(a.store, a.src, { async assistant() { return null; } }).d), 'skipped_assistant_gone');
    const b = await oneFound();
    assert.equal(await writeImport(b.id, deps(b.store, fakeSource({ connected: false })).d), 'skipped_disconnected');
});

await test('moderation block: skipped, model never called', async () => {
    const { store, src, id } = await oneFound();
    const { d, log } = deps(store, src, { async blocked() { return true; } });
    assert.equal(await writeImport(id, d), 'skipped_blocked');
    assert.equal(log.written.length, 0);
});

await test('model failures retry, then give up as failed', async () => {
    const { store, rows, src, id } = await oneFound();
    let clock = new Date(T0.getTime() + 30 * 60 * 1000);
    const { d } = deps(store, src, { now: () => clock, async writeMinutes() { return { ok: false, reason: 'model_failed' }; } });
    const outcomes: string[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        outcomes.push(await writeImport(id, d));
        clock = new Date(clock.getTime() + 16 * 60 * 1000);
    }
    assert.deepEqual(outcomes, [...Array(MAX_ATTEMPTS - 1).fill('retry'), 'failed']);
    assert.equal(rows.get(id)!.status, 'failed');
    assert.doesNotMatch(rows.get(id)!.lastError!, /vendor|Ana|Bo/i, 'no transcript text in the error');
});

await test('a thrown error retries; filing failure retries; nothing charged', async () => {
    const { store, rows, id } = await oneFound();
    const throwing = { ...fakeSource(), async fetchTranscript(): Promise<PickedTranscript | null> { throw new Error('socket hang up'); } };
    assert.equal(await writeImport(id, deps(store, throwing).d), 'retry');
    assert.equal(rows.get(id)!.status, 'found');
    const b = await oneFound();
    const { d, log } = deps(b.store, b.src, { async file() { return null; } });
    assert.equal(await writeImport(b.id, d), 'retry');
    assert.equal(log.charged.length, 0);
});

await test('once filed, a failing latch is never retried (no second copy in the Inbox)', async () => {
    const { store, rows, src, id } = await oneFound();
    const broken: PickupStore = { ...store, async markWritten() { throw new Error('db gone'); } };
    const { d, log } = deps(broken, src);
    assert.equal(await writeImport(id, d), 'failed');
    assert.equal(rows.get(id)!.status, 'failed');
    assert.match(rows.get(id)!.lastError!, /Filed as record 901/);
    assert.equal(log.charged.length, 0);
});

await test('two writers: only one gets the meeting', async () => {
    const { store, src, id } = await oneFound();
    const { d, log } = deps(store, src);
    const [a, b] = await Promise.all([writeImport(id, d), writeImport(id, d)]);
    assert.deepEqual([a, b].sort(), ['not_claimed', 'written']);
    assert.equal(log.filed.length, 1);
});

// ── Wiring (source scans) ────────────────────────────────────────────────────────────────────────
await test('cost: meeting_pickup is 1 task, seeded for Admin', () => {
    assert.equal(DEFAULT_TASK_WEIGHTS.meeting_pickup, 1);
    assert.match(readFileSync('db/z-task-costs.sql', 'utf8'), /\(1, 'meeting_pickup', 1\)/);
});

await test('functions: scheduled every 15 min, staging twin, secret-guarded background writer', () => {
    assert.match(readFileSync('netlify/functions/meeting-pickup.ts', 'utf8'), /schedule: '\*\/15 \* \* \* \*'/);
    const twin = readFileSync('netlify/functions/run-meeting-pickup.ts', 'utf8');
    assert.match(twin, /CRON_TRIGGER_SECRET/);
    assert.match(readFileSync('.github/workflows/staging-crons.yml', 'utf8'), /run-meeting-pickup\s+900\s+60/);
    const bg = readFileSync('netlify/functions/meeting-import-background.ts', 'utf8');
    assert.match(bg, /if \(!secret\)/);
    assert.match(bg, /writeImport\(importId, writerDeps\(getDb\(\)\)\)/);
});

await test('the form and pick-up share one minutes writer', () => {
    const form = readFileSync('netlify/functions/meeting-minutes.ts', 'utf8');
    assert.match(form, /writeMeetingMinutes\(db, \{/);
    assert.doesNotMatch(form, /anthropic\.messages\.create/);
    const dbFile = readFileSync('src/utils/meeting-pickup-db.ts', 'utf8');
    assert.match(dbFile, /channelBlock: PICKUP_CHANNEL_BLOCK/);
    assert.match(dbFile, /recordCompletedWork\(db, organisationId, 'meeting_pickup'/);
});

await test('Inbox and chat say where a meeting came from', () => {
    const js = readFileSync('assistants.js', 'utf8');
    // With the card, not inside the follow-up preview (which is empty when a meeting has no follow-up email).
    assert.match(js, /\$\{_rqMeetingPickedUp\(r\)\}\$\{_rqOutreachPreview\(r, statusKey\)\}/);
    assert.match(js, /Picked up from \$\{_rqEsc\(p\.label\)\}/);
    assert.match(readFileSync('src/utils/chat-meeting-action.ts', 'utf8'), /picked up from \$\{pickedUpLabel\(d\)\}/);
});

await test('SQL: unique key per workspace, platform and meeting', () => {
    const sqlText = readFileSync('db/z-meeting-imports.sql', 'utf8');
    assert.match(sqlText, /UNIQUE INDEX IF NOT EXISTS meeting_imports_org_platform_external_uq ON meeting_imports \(organisation_id, platform, external_id\)/);
    assert.match(sqlText, /CREATE TABLE IF NOT EXISTS meeting_pickup_state/);
});

await test('an Inbox edit can neither drop nor invent where a meeting came from', async () => {
    const { keepServerOwnedMeetingKeys } = await import('../src/utils/meeting-handoff-once');
    const stored = { meetingTitle: 'x', pickedUpFrom: { platform: 'zoom', label: 'Zoom' } };
    assert.deepEqual(keepServerOwnedMeetingKeys({ meetingTitle: 'y' }, stored).pickedUpFrom, stored.pickedUpFrom);
    assert.equal('pickedUpFrom' in keepServerOwnedMeetingKeys({ pickedUpFrom: { label: 'Forged' } }, { meetingTitle: 'x' }), false);
});

await test('scheduler auth is shared, not imported from another feature', () => {
    assert.match(readFileSync('netlify/functions/meeting-pickup.ts', 'utf8'), /from '\.\.\/\.\.\/src\/utils\/scheduled-run-auth'/);
    assert.match(readFileSync('src/utils/meeting-pickup-db.ts', 'utf8'), /Promise\.all\(due\.map/);
});

console.log(`meeting-pickup: ${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
