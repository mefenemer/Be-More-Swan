// Google Meet as a pick-up source (src/utils/meeting-sources/google-meet.ts), against a fake Meet API shaped like the
// real responses read on 2026-11-19 (plan Phase 0). Run: npx tsx tests/meeting-pickup-google-meet.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    GOOGLE_MEET_READ_SCOPE, GOOGLE_MEET_SCOPE, listAll, listEndedCalls, meetFetcher, participantName, readTranscript, type MeetFetch,
} from '../src/utils/meeting-sources/google-meet';
import { speakerLines } from '../src/utils/meeting-pickup';

(async () => {
    let passed = 0;
    const test = async (_name: string, fn: () => Promise<void> | void) => { await fn(); passed++; };

    // A fake Meet API: path → JSON, recording every path asked for.
    function fakeMeet(routes: Record<string, unknown>): MeetFetch & { calls: string[] } {
        const calls: string[] = [];
        const get = (async (path: string) => {
            calls.push(path);
            const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + '?') || path.startsWith(k + '&'));
            if (!key) throw new Error(`Google Meet 404 NOT_FOUND (${path})`);
            const v = routes[key];
            return typeof v === 'function' ? (v as (p: string) => unknown)(path) : v;
        }) as MeetFetch & { calls: string[] };
        get.calls = calls;
        return get;
    }

    const now = new Date('2026-11-19T05:00:00Z');
    const since = new Date('2026-11-19T04:00:00Z');

    await test('scope: only the Meet read scope plus openid email — no Drive', () => {
        assert.equal(GOOGLE_MEET_READ_SCOPE, 'https://www.googleapis.com/auth/meetings.space.readonly');
        assert.equal(GOOGLE_MEET_SCOPE, 'https://www.googleapis.com/auth/meetings.space.readonly openid email');
        assert.doesNotMatch(GOOGLE_MEET_SCOPE, /drive/);
    });

    await test('participant names: signed-in, guest, phone, or none', () => {
        assert.equal(participantName({ name: 'p/1', signedinUser: { displayName: 'Mark Fenemer' } }), 'Mark Fenemer');
        assert.equal(participantName({ name: 'p/2', anonymousUser: { displayName: 'Guest' } }), 'Guest');
        assert.equal(participantName({ name: 'p/3', phoneUser: { displayName: ' +44 ••• 123 ' } }), '+44 ••• 123');
        assert.equal(participantName({ name: 'p/4' }), null);
    });

    await test('paging follows nextPageToken', async () => {
        const get = fakeMeet({
            things: (p: string) => p.includes('pageToken=B') ? { things: [3] } : { things: [1, 2], nextPageToken: 'B' },
        });
        assert.deepEqual(await listAll<number>(get, 'things', 'things'), [1, 2, 3]);
        assert.match(get.calls[0], /^things\?pageSize=100$/);
        assert.match(get.calls[1], /pageToken=B/);
    });

    await test('ended calls: filtered by end time, ongoing ones left out, oldest first, one space look-up each', async () => {
        const get = fakeMeet({
            conferenceRecords: { conferenceRecords: [
                { name: 'conferenceRecords/late', startTime: '2026-11-19T04:30:00Z', endTime: '2026-11-19T04:50:00Z', space: 'spaces/S1' },
                { name: 'conferenceRecords/live', startTime: '2026-11-19T04:55:00Z', space: 'spaces/S2' },
                { name: 'conferenceRecords/early', startTime: '2026-11-19T04:10:19Z', endTime: '2026-11-19T04:13:06Z', space: 'spaces/S1' },
            ] },
            'spaces/S1': { name: 'spaces/S1', meetingUri: 'https://meet.google.com/abc-defg-hij' },
        });
        const calls = await listEndedCalls(get, since, now);
        assert.deepEqual(calls.map((c) => c.externalId), ['conferenceRecords/early', 'conferenceRecords/late']);
        assert.equal(calls[0].link, 'https://meet.google.com/abc-defg-hij');
        assert.equal(calls[0].endedAt.toISOString(), '2026-11-19T04:13:06.000Z');
        assert.equal(calls[0].title, null);
        assert.equal(decodeURIComponent(get.calls[0]), 'conferenceRecords?filter=end_time>="2026-11-19T04:00:00.000Z"&pageSize=100');
        assert.equal(get.calls.filter((p) => p === 'spaces/S1').length, 1, 'the space is read once');
    });

    await test('a space that cannot be read still lists the call, without a link', async () => {
        const get = fakeMeet({ conferenceRecords: { conferenceRecords: [
            { name: 'conferenceRecords/a', endTime: '2026-11-19T04:20:00Z', space: 'spaces/gone' },
        ] } });
        const calls = await listEndedCalls(get, since, now);
        assert.deepEqual([calls.length, calls[0].link], [1, null]);
    });

    const REC = 'conferenceRecords/a';
    const participants = { participants: [
        { name: `${REC}/participants/1`, signedinUser: { displayName: 'Ana Lopez' } },
        { name: `${REC}/participants/2`, anonymousUser: { displayName: 'Bo Chen' } },
        { name: `${REC}/participants/3`, phoneUser: { displayName: 'Cara' } },
    ] };

    await test('ENDED waits for the grace period; any STARTED transcript waits', async () => {
        const ended = { [`${REC}/transcripts`]: { transcripts: [{ name: `${REC}/transcripts/t1`, state: 'ENDED' }] }, [`${REC}/participants`]: participants, [`${REC}/transcripts/t1/entries`]: { transcriptEntries: [{ participant: `${REC}/participants/1`, text: 'Hi' }] } };
        const t0 = new Date('2026-11-19T05:00:00Z');
        assert.equal(await readTranscript(fakeMeet(ended), REC, new Date(t0.getTime() - 5 * 60 * 1000), t0), null, 'ENDED 5 minutes after the call: not yet');
        assert.ok(await readTranscript(fakeMeet(ended), REC, new Date(t0.getTime() - 31 * 60 * 1000), t0), 'ENDED 31 minutes after: read');
        const mixed = fakeMeet({ [`${REC}/transcripts`]: { transcripts: [{ name: 'a', state: 'FILE_GENERATED' }, { name: 'b', state: 'STARTED' }] } });
        assert.equal(await readTranscript(mixed, REC, new Date(0), t0), null, 'a second transcript still running: wait for all of it');
    });

    await test('transcript not ready (STARTED) or missing: null, nothing else read', async () => {
        const started = fakeMeet({ [`${REC}/transcripts`]: { transcripts: [{ name: `${REC}/transcripts/t1`, state: 'STARTED' }] } });
        assert.equal(await readTranscript(started, REC), null);
        assert.equal(started.calls.length, 1);
        const none = fakeMeet({ [`${REC}/transcripts`]: {} });
        assert.equal(await readTranscript(none, REC), null);
    });

    await test('transcript: speakers named from participants, entries from every finished transcript in time order', async () => {
        const get = fakeMeet({
            [`${REC}/transcripts`]: { transcripts: [
                { name: `${REC}/transcripts/t2`, state: 'FILE_GENERATED' },
                { name: `${REC}/transcripts/t1`, state: 'ENDED' },
            ] },
            [`${REC}/participants`]: participants,
            [`${REC}/transcripts/t1/entries`]: { transcriptEntries: [
                { participant: `${REC}/participants/1`, text: 'We go with vendor A.', startTime: '2026-11-19T04:10:28Z' },
                { participant: `${REC}/participants/1`, text: 'Bo, send the contract by Friday.', startTime: '2026-11-19T04:10:53Z' },
            ] },
            [`${REC}/transcripts/t2/entries`]: { transcriptEntries: [
                { participant: `${REC}/participants/2`, text: ' Will do. Legal may be slow.', startTime: '2026-11-19T04:20:00.512Z' },
                { participant: `${REC}/participants/9`, text: 'Someone who left the list', startTime: '2026-11-19T04:20:00.9Z' },
            ] },
        });
        const t = (await readTranscript(get, REC, new Date('2026-11-19T04:30:00Z'), new Date('2026-11-19T06:00:00Z')))!;
        assert.deepEqual(speakerLines(t.lines), [
            'Ana Lopez: We go with vendor A. Bo, send the contract by Friday.',
            'Bo Chen: Will do. Legal may be slow.',
            'Unknown speaker: Someone who left the list',
        ]);
        assert.deepEqual(t.attendees, ['Ana Lopez', 'Bo Chen', 'Cara'], 'the silent attendee is still present');
    });

    await test('fetcher: bearer token, status in the error, never the body or token', async () => {
        let seen: RequestInit | undefined;
        const ok = meetFetcher('tok-123', (async (_u: string, init?: RequestInit) => { seen = init; return new Response('{"a":1}', { status: 200 }); }) as typeof fetch);
        assert.deepEqual(await ok('conferenceRecords'), { a: 1 });
        assert.equal((seen!.headers as Record<string, string>).Authorization, 'Bearer tok-123');
        const bad = meetFetcher('tok-123', (async () => new Response('{"error":{"status":"PERMISSION_DENIED","message":"secret detail"}}', { status: 403 })) as typeof fetch);
        await assert.rejects(bad('conferenceRecords'), (e: Error) => e.message === 'Google Meet 403 PERMISSION_DENIED' && !/tok-123|secret detail/.test(e.message));
    });

    // ── Wiring (source scans) ────────────────────────────────────────────────────────────────────
    await test('connect is gated by the meeting_pickup flag and asks for the Meet scope with offline access', () => {
        const o = readFileSync('netlify/functions/oauth-integrations.ts', 'utf8');
        assert.match(o, /provider === 'google_meet' && !\(await isFeatureEnabled\(organisationId, MEETING_PICKUP_FLAG\)\)/);
        assert.match(o, /google_meet: GOOGLE_MEET_SCOPE,/);
        assert.match(o, /scope=\$\{encodeURIComponent\(SCOPES\.google_meet\)\}&access_type=offline/);
        assert.match(o, /includes\(GOOGLE_MEET_READ_SCOPE\)\) \{\n\s+return redirect\('\/integrations\.html\?oauth_error=scope_missing&provider=google_meet'\)/);
        assert.match(o, /client_id: process\.env\.GOOGLE_MEET_CLIENT_ID/);
    });

    await test('tokens refresh with the same client', () => {
        const w = readFileSync('src/utils/workspace-integrations.ts', 'utf8');
        assert.match(w, /if \(provider === 'google_meet'\) \{[\s\S]{0,700}GOOGLE_MEET_CLIENT_ID/);
        assert.match(w, /'canva', 'google_meet',\n\]\);/, 'auto-refreshed');
    });

    await test('only flagged workspaces are read; the Note Taker policy includes meeting apps', () => {
        assert.match(readFileSync('src/utils/meeting-sources/google-meet.ts', 'utf8'), /if \(!\(await isFeatureEnabled\(r\.organisationId, MEETING_PICKUP_FLAG\)\)\) continue;/);
        assert.match(readFileSync('src/utils/connection-map.ts', 'utf8'), /meeting_note_taker:\s+\['meeting_apps', 'email', 'calendar', 'knowledge'\]/);
        assert.match(readFileSync('db/z-meeting-pickup-flag.sql', 'utf8'), /VALUES \('meeting_pickup', FALSE, 0, NULL,/);
    });

    await test('Connections tab: a Meet row replaces the coming-soon card only when the flag sends meetingApps', () => {
        const j = readFileSync('integrations.js', 'utf8');
        assert.match(j, /!\(t\.key === 'meeting_apps' && _meetingApps\)/);
        assert.match(j, /function _meetingAppCard\(m\)/);
        assert.match(j, /\/api\/oauth\/google_meet\/connect/);
        assert.match(j, /\[\['teams_pickup', 'Microsoft Teams'\], \['zoom_pickup', 'Zoom'\]\]/);
        assert.match(readFileSync('netlify/functions/oauth-integrations.ts', 'utf8'), /db\.delete\(meetingPickupState\)/, 'a reconnect restarts the look-back');
        assert.match(readFileSync('netlify/functions/integrations.ts', 'utf8'), /usesMeetingApps\(assistant\) && currentOrgId \? await loadMeetingApps\(db, currentOrgId\) : null/);
    });

    console.log(`meeting-pickup-google-meet: ${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
