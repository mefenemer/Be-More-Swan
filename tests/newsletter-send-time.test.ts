// tests/newsletter-send-time.test.ts
// What time is it for the person receiving this?
//
// Two questions that look like one, and both of them have a wrong answer that says nothing:
//
//   1. ⚠️ WHEN DID THE SENDER MEAN? "9:00" is not an instant. The server parsed a bare wall-clock
//      string with no zone on it, which made it 09:00 UTC — ten in the morning for a British sender
//      in summer, the previous evening for one in Sydney. Nothing said so, which is what made it a
//      bug rather than a setting.
//   2. WHEN IS IT FOR THE READER? Needs a timezone per subscriber, which we have only when a
//      browser told us. ⚠️ "Unknown" must stay a first-class answer: inferring it from a sign-up IP
//      would be a guess presented as a fact in the one place where being wrong means 3am.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    dueAtForRecipient, instantToWallClock, isValidTimezone, LOCAL_TIME_RE,
    MAX_LOCAL_SPREAD_HOURS, resolveSendTimezone, wallClockToInstant,
} from '../src/utils/newsletter-schedule';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
}

const SQL = read('db/newsletter-send-time.sql');
const API = read('netlify/functions/newsletter-issues.ts');
const SEND = read('src/utils/newsletter-send.ts');
const PUBLIC = read('netlify/functions/audience-public.ts');
const STORE = read('src/utils/audience-store.ts');
const UI = read('newsletter.js');
const EMBED = read('subscribe.js');

console.log('\nSend time and timezones\n');

// ── 1. What the sender meant ────────────────────────────────────────────────

check('a wall-clock time is read in the stated zone, not as UTC', () => {
    // ⚠️ The bug: 09:00 typed by a London sender in AUGUST is 08:00 UTC (BST), not 09:00 UTC.
    const summer = wallClockToInstant('2026-08-25T09:00', 'Europe/London');
    assert.strictEqual(summer!.toISOString(), '2026-08-25T08:00:00.000Z');
    // And in winter, when London IS UTC, the same input is a different instant.
    const winter = wallClockToInstant('2026-12-25T09:00', 'Europe/London');
    assert.strictEqual(winter!.toISOString(), '2026-12-25T09:00:00.000Z');
});

check('the zone actually changes the answer for a far-away sender', () => {
    const sydney = wallClockToInstant('2026-08-25T09:00', 'Australia/Sydney');
    assert.strictEqual(sydney!.toISOString(), '2026-08-24T23:00:00.000Z', 'the evening BEFORE, in UTC');
});

check('a full instant is left alone rather than re-interpreted', () => {
    // It already carries a zone; reading it in another one would move it.
    const iso = '2026-08-25T09:00:00.000Z';
    assert.strictEqual(wallClockToInstant(iso, 'Australia/Sydney')!.toISOString(), iso);
});

check('the round trip returns the same wall clock', () => {
    for (const tz of ['Europe/London', 'Australia/Sydney', 'America/Los_Angeles', 'Asia/Kolkata']) {
        const wall = '2026-08-25T09:00';
        assert.strictEqual(instantToWallClock(wallClockToInstant(wall, tz)!, tz), wall, `round trip in ${tz}`);
    }
});

check('the zone is STAMPED on the issue when it is scheduled', () => {
    // An assistant's posting_timezone can change between scheduling and sending; the moment the
    // human agreed to must not follow it.
    assert.match(API, /if \(when\) patch\.sendTimezone = tz/);
    assert.match(API, /sendTimezone: when \? approveTz : issue\.sendTimezone/);
    assert.match(SQL, /Stamped, not resolved at send time/);
});

check('the browser is told the zone and the wall clock, and converts neither', () => {
    // ⚠️ Somebody editing from another country would otherwise see, and re-save, a different time
    // from the one the issue goes out at.
    assert.match(API, /scheduledForLocal: issue\.scheduledFor \? instantToWallClock/);
    assert.match(UI, /\$\('nl-schedule'\)\.value = scheduledForLocal \|\| ''/);
    assert.match(UI, /scheduledFor: \$\('nl-schedule'\)\.value \|\| null/, 'sent as typed, not converted');
    assert.ok(!/new Date\(\$\('nl-schedule'\)\.value\)/.test(UI), 'no browser-clock conversion may remain');
});

check('the zone is named on screen', () => {
    assert.match(UI, /Times are \$\{state\.sendTimezone/);
});

// ── 2. When it is for the reader ────────────────────────────────────────────

check('a recipient is sent at their own local time', () => {
    // 08:00 UTC start; 09:00 local in Berlin (UTC+2 in August) is 07:00 UTC — already past, so...
    const startedAt = new Date('2026-08-25T08:00:00.000Z');
    const la = dueAtForRecipient({ startedAt, localTime: '09:00', senderTimezone: 'Europe/London', recipientTimezone: 'America/Los_Angeles' });
    // Los Angeles is UTC-7 in August: 09:00 there is 16:00 UTC, later the same day.
    assert.strictEqual(la.toISOString(), '2026-08-25T16:00:00.000Z');
});

check('a time already past where they are goes out NOW, not tomorrow', () => {
    // ⚠️ An issue being sent now is news now. Holding it 23 hours to hit a nicer clock face would
    // deliver yesterday's newsletter.
    const startedAt = new Date('2026-08-25T08:00:00.000Z');   // 18:00 in Sydney
    const syd = dueAtForRecipient({ startedAt, localTime: '09:00', senderTimezone: 'Europe/London', recipientTimezone: 'Australia/Sydney' });
    assert.strictEqual(syd.getTime(), startedAt.getTime());
});

check('an unknown timezone falls back to the sender, not to a guess', () => {
    const startedAt = new Date('2026-08-25T08:00:00.000Z');
    const unknown = dueAtForRecipient({ startedAt, localTime: '12:00', senderTimezone: 'Europe/London', recipientTimezone: null });
    // 12:00 London in August = 11:00 UTC.
    assert.strictEqual(unknown.toISOString(), '2026-08-25T11:00:00.000Z');
    const junk = dueAtForRecipient({ startedAt, localTime: '12:00', senderTimezone: 'Europe/London', recipientTimezone: 'Mars/Olympus' });
    assert.strictEqual(junk.getTime(), unknown.getTime(), 'junk is treated as unknown, never thrown on');
});

check('nothing can be queued days out', () => {
    const startedAt = new Date('2026-08-25T08:00:00.000Z');
    const due = dueAtForRecipient({ startedAt, localTime: '09:00', senderTimezone: 'Europe/London', recipientTimezone: 'Pacific/Kiritimati' });
    assert.ok(due.getTime() - startedAt.getTime() <= MAX_LOCAL_SPREAD_HOURS * 3600 * 1000);
});

check('a timezone from a browser is validated before it is stored', () => {
    // ⚠️ Anyone can post anything to the sign-up endpoint, and an unknown zone reaching Intl inside
    // the send worker throws — which would fail a whole batch over one row.
    assert.ok(isValidTimezone('Europe/London'));
    assert.ok(!isValidTimezone('Mars/Olympus'));
    assert.ok(!isValidTimezone(''));
    assert.ok(!isValidTimezone('x'.repeat(200)));
    assert.match(PUBLIC, /isValidTimezone\(body\.timezone\) \? body\.timezone : null/);
    assert.match(PUBLIC, /never inferred from the IP|never inferred from the IP address|It is never inferred/);
});

check('both sign-up surfaces report it', () => {
    assert.match(PUBLIC, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/, 'the hosted page');
    assert.match(EMBED, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/, 'the embeddable widget');
    assert.match(EMBED, /catch \(tzErr\)/, 'and neither may throw on an old browser');
});

check('a newer zone replaces an older one, and an absent one erases nothing', () => {
    // People move; a stale zone sends confidently at the wrong hour, which is worse than none.
    assert.match(STORE, /timezone: sql`COALESCE\(EXCLUDED\.timezone, \$\{audienceContacts\.timezone\}\)`/);
});

// ── 3. The send path ────────────────────────────────────────────────────────

check('the batch only takes rows that are due', () => {
    const fn = SEND.slice(landmark(SEND, 'const queued = await db'), landmark(SEND, 'if (!queued.length)'));
    assert.match(fn, /dueAt\} IS NULL OR/);
});

check('rows that are not due yet keep the issue sending', () => {
    // ⚠️ Reporting the issue done because nothing is due YET would mark it sent with most of the
    // list unsent.
    const fn = SEND.slice(landmark(SEND, 'const [{ remaining }]'), landmark(SEND, 'return { issueId: issue.id, sent'));
    assert.ok(!fn.includes('dueAt'), 'the remaining count must ignore due_at');
    assert.match(SEND, /Counts every queued row, DUE OR NOT/);
});

check('a local-time send freezes its audience once it starts', () => {
    // ⚠️ It stays open for up to a day. Without this, somebody subscribing mid-send is swept into
    // an issue that began yesterday — with a due time computed from a start they were not part of.
    assert.match(SEND, /claimed\.sendMode === 'recipient_local' && !!claimed\.sendingStartedAt/);
});

check('the due time is computed once, against the issue start', () => {
    // Recomputing per tick would drift the target as the clock moved.
    assert.match(SEND, /const startedAt = issue\.sendingStartedAt \?\? new Date\(\)/);
    assert.match(SEND, /dueAtForRecipient\(/);
});

check('no new scheduled function was added for any of this', () => {
    const toml = read('netlify.toml');
    assert.ok(!/newsletter-send-time|newsletter-local/.test(toml));
});

// ── 4. The combination that would lie ───────────────────────────────────────

check('a local-time send and an A/B test refuse to run together', () => {
    // ⚠️ A test decides from the first few hours of opens; a local-time send spreads the sample
    // across a day. Together they produce a "subject-line finding" that is really a map of where a
    // list lives.
    const sendTime = API.slice(landmark(API, "if (action === 'sendTime')"), landmark(API, "if (action === 'abTest')"));
    assert.match(sendTime, /issue\.abState === 'testing'/);
    const ab = API.slice(landmark(API, "if (action === 'abTest')"), landmark(API, "if (action === 'update')"));
    assert.match(ab, /issue\.sendMode === 'recipient_local'/, 'and the refusal works in both directions');
});

check('the tenant is told how many timezones we actually know', () => {
    const fn = API.slice(landmark(API, "if (action === 'sendTime')"), landmark(API, "if (action === 'abTest')"));
    assert.match(fn, /knownTimezones/);
    assert.match(UI, /will get it at \$\{localTime\} your time/);
});

check('the local time is validated', () => {
    assert.ok(LOCAL_TIME_RE.test('09:00') && LOCAL_TIME_RE.test('23:59'));
    assert.ok(!LOCAL_TIME_RE.test('24:00') && !LOCAL_TIME_RE.test('9:00') && !LOCAL_TIME_RE.test('nine'));
    assert.match(API, /LOCAL_TIME_RE\.test\(localTime\)/);
});

check('an issue with no mode set behaves exactly as before', () => {
    assert.match(SQL, /send_mode TEXT NOT NULL DEFAULT 'at_once'/);
    assert.strictEqual(resolveSendTimezone(null), 'Europe/London', 'the product default, not the server clock');
});

console.log(`\n${passed} checks passed.`);
