// tests/calendar-sync.test.ts
// The owner's calendar with no sign-in (docs/booking-plan.md phase 3): busy times read from their
// private iCal address (ical-busy.ts, calendar-sync.ts) block appointments; their bookings appear in
// their calendar through a private subscribe link (booking-calendar-feed.ts).
//
// Run:  npx tsx tests/calendar-sync.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { busyTimes, expandDates, parseDuration, parseWhen, unfold } from '../src/utils/ical-busy';
import { availableSlots } from '../src/utils/booking-availability';
import { cleanCalendarUrl, syncErrorText, vaultKeyFor } from '../src/utils/calendar-sync';
import { buildOwnerFeed, feedUrl, fold, FEED_TOKEN_RE, newFeedToken, webcalUrl } from '../src/utils/booking-calendar-feed';
import { SafeFetchError } from '../src/utils/safe-fetch';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const ics = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const iso = (b: { start: Date; end: Date }) => `${b.start.toISOString().slice(0, 16)}–${b.end.toISOString().slice(11, 16)}`;
const window = [new Date('2026-10-19T00:00:00Z'), new Date('2026-12-31T00:00:00Z')] as const;

console.log('\nReading a calendar');

check('folded lines, UTC / zoned / all-day times and durations', () => {
    assert.deepStrictEqual(unfold('SUMMARY:Long\r\n  title\r\nUID:x'), ['SUMMARY:Long title', 'UID:x']);
    assert.deepStrictEqual(parseWhen('20261020T090000Z', {}, 'Europe/London'), { date: '2026-10-20', time: '09:00', tz: 'UTC' });
    assert.deepStrictEqual(parseWhen('20261020T090000', { TZID: 'GMT Standard Time' }, 'UTC'), { date: '2026-10-20', time: '09:00', tz: 'Europe/London' }, 'Outlook zone names');
    assert.deepStrictEqual(parseWhen('20261020', { VALUE: 'DATE' }, 'Europe/London'), { date: '2026-10-20', time: null, tz: 'Europe/London' });
    assert.strictEqual(parseDuration('PT1H30M'), 90);
    assert.strictEqual(parseDuration('P1D'), 1440);
});
check('a weekly repeat with an exception and a moved occurrence, right across the clock change', () => {
    const text = ics(
        ['UID:a@google.com', 'DTSTART;TZID=Europe/London:20261020T090000', 'DTEND;TZID=Europe/London:20261020T100000', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6', 'EXDATE;TZID=Europe/London:20261022T090000'],
        ['UID:a@google.com', 'RECURRENCE-ID;TZID=Europe/London:20261027T090000', 'DTSTART;TZID=Europe/London:20261027T110000', 'DTEND;TZID=Europe/London:20261027T120000'],
    );
    assert.deepStrictEqual(busyTimes(text, 'Europe/London', ...window).map(iso), [
        '2026-10-20T08:00–09:00', '2026-10-27T11:00–12:00', '2026-10-29T09:00–10:00', '2026-11-03T09:00–10:00', '2026-11-05T09:00–10:00',
    ]);
});
check('free, cancelled and our own events are not busy; alarms inside an event are ignored', () => {
    const text = ics(
        ['UID:b@google.com', 'DTSTART;VALUE=DATE:20261021', 'DTEND;VALUE=DATE:20261022', 'TRANSP:TRANSPARENT'],
        ['UID:c@google.com', 'DTSTART:20261021T130000Z', 'DTEND:20261021T143000Z', 'STATUS:CANCELLED'],
        ['UID:owner-booking-5@bemoreswan.com', 'DTSTART:20261021T150000Z', 'DTEND:20261021T160000Z'],
        ['UID:d@google.com', 'DTSTART:20261022T100000Z', 'DURATION:PT45M', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'DTSTART:20990101T000000Z', 'END:VALARM'],
    );
    assert.deepStrictEqual(busyTimes(text, 'Europe/London', ...window).map(iso), ['2026-10-22T10:00–10:45']);
});
check('an all-day busy day blocks the whole day in the business\'s zone', () => {
    const text = ics(['UID:e@x', 'DTSTART;VALUE=DATE:20261123', 'DTEND;VALUE=DATE:20261124']);
    assert.deepStrictEqual(busyTimes(text, 'Europe/London', ...window).map(iso), ['2026-11-23T00:00–00:00']);
});
check('monthly by week day, monthly by date, daily with an end date', () => {
    assert.deepStrictEqual(expandDates('2026-10-05', 'FREQ=MONTHLY;BYDAY=1MO', '2026-12-31'), ['2026-10-05', '2026-11-02', '2026-12-07']);
    assert.deepStrictEqual(expandDates('2026-10-30', 'FREQ=MONTHLY;BYDAY=-1FR', '2026-12-31'), ['2026-10-30', '2026-11-27', '2026-12-25']);
    assert.deepStrictEqual(expandDates('2026-10-31', 'FREQ=MONTHLY', '2027-01-31'), ['2026-10-31', '2026-12-31', '2027-01-31'], 'no 31 November');
    assert.deepStrictEqual(expandDates('2026-10-20', 'FREQ=DAILY;INTERVAL=2;UNTIL=20261026T235959Z', '2026-12-31'), ['2026-10-20', '2026-10-22', '2026-10-24', '2026-10-26']);
});

console.log('\nBlocking bookings');

const settings = { timezone: 'Europe/London', weeklyHours: { tue: [{ start: '09:00', end: '12:00' }] }, closures: [], minNoticeMinutes: 0, maxAdvanceDays: 60, slotIntervalMinutes: 60, bufferMinutes: 0, tableMinutes: 90, maxPartySize: 8 };
const q = { date: '2026-10-20', kind: 'appointment' as const, durationMinutes: 60, serviceId: 1, resourceId: null, partySize: 1, now: new Date('2026-10-19T00:00:00Z') };
const staff = [{ id: 1, name: 'Sarah', capacity: 1, weeklyHours: null, serviceIds: null }, { id: 2, name: 'Elena', capacity: 1, weeklyHours: null, serviceIds: null }];
const tenToEleven = { startsAt: new Date('2026-10-20T09:00:00Z'), endsAt: new Date('2026-10-20T10:00:00Z') };   // 10–11am BST

check('the business\'s busy time blocks everyone; a person\'s blocks only them', () => {
    const times = (busy: Parameters<typeof availableSlots>[4]) => availableSlots(settings, staff, [], q, busy).map((s) => `${s.time}:${s.resourceIds.join('+')}`);
    assert.deepStrictEqual(times([]), ['09:00:1+2', '10:00:1+2', '11:00:1+2']);
    assert.deepStrictEqual(times([{ resourceId: null, ...tenToEleven }]), ['09:00:1+2', '11:00:1+2']);
    assert.deepStrictEqual(times([{ resourceId: 1, ...tenToEleven }]), ['09:00:1+2', '10:00:2', '11:00:1+2']);
});
check('a solo business (no staff) and tables', () => {
    assert.deepStrictEqual(availableSlots(settings, [], [], q, [{ resourceId: null, ...tenToEleven }]).map((s) => s.time), ['09:00', '11:00']);
    const tables = availableSlots(settings, [], [], { ...q, kind: 'table', serviceId: null, partySize: 2 }, [{ resourceId: null, ...tenToEleven }]);
    assert.ok(tables.some((s) => s.time === '10:00'), 'tables are never blocked by the owner\'s calendar');
});

console.log('\nThe address');

check('webcal becomes https; only https; never user:password@', () => {
    const ok = cleanCalendarUrl(' webcal://calendar.google.com/calendar/ical/abc%40group/private-xyz/basic.ics ');
    assert.ok(ok.ok && ok.value.url.startsWith('https://calendar.google.com/') && ok.value.host === 'calendar.google.com');
    assert.ok(!cleanCalendarUrl('http://example.com/cal.ics').ok);
    assert.ok(!cleanCalendarUrl('https://user:pw@example.com/cal.ics').ok);
    assert.ok(!cleanCalendarUrl('').ok);
});
check('the address is a secret: vault only, fetched through the SSRF fence, never logged', () => {
    assert.strictEqual(vaultKeyFor(9, { resourceId: null }), 'aura/org-9/busy-calendar-business');
    assert.strictEqual(vaultKeyFor(9, { resourceId: 4 }), 'aura/org-9/busy-calendar-resource-4');
    const src = read('src/utils/calendar-sync.ts');
    assert.ok(src.includes('await storeSecret(asVaultDb(db), key, { url: c.value.url });') && src.includes('safeFetchText(url, {'));
    assert.ok(!/console\.(error|log)\([^)]*url/.test(src), 'the address never reaches a log');
    assert.ok(read('db/z-calendar-sync.sql').includes('it lives in the vault (vault.ts), never in a\n--      column'));
});
check('problems in plain words', () => {
    assert.ok(/reset/.test(syncErrorText(new SafeFetchError('That link returned an error (404).', 'http_error'))));
    assert.ok(/can't be reached/.test(syncErrorText(new SafeFetchError('x', 'private_address'))));
    assert.ok(/iCal format/.test(syncErrorText(new Error('not_a_calendar'))));
});

console.log('\nBookings into their calendar');

check('a private 32-hex token; https and webcal links', () => {
    const t = newFeedToken();
    assert.ok(FEED_TOKEN_RE.test(t));
    const u = feedUrl('https://bemoreswan.com/', t);
    assert.strictEqual(u, `https://bemoreswan.com/api/bookings/calendar.ics?t=${t}`);
    assert.strictEqual(webcalUrl(u), `webcal://bemoreswan.com/api/bookings/calendar.ics?t=${t}`);
});
check('the feed: bookings with who and how to reach them, class dates once with who\'s coming, cancelled marked', () => {
    const body = buildOwnerFeed({
        business: 'Willowbrook, Salon', now: new Date('2026-10-15T12:00:00Z'),
        bookings: [
            { id: 1, kind: 'appointment', status: 'pending', startsAt: new Date('2026-10-20T09:00:00Z'), endsAt: new Date('2026-10-20T10:00:00Z'), what: 'Cut & finish with Elena', customerName: 'Sam P', customerEmail: 'sam@example.com', customerPhone: '07700 900123', notes: 'Fringe, please', partySize: 1, depositPence: 1000, paymentStatus: 'paid' },
            { id: 2, kind: 'class', status: 'confirmed', startsAt: new Date('2026-10-21T17:00:00Z'), endsAt: new Date('2026-10-21T18:00:00Z'), what: 'Vinyasa', customerName: 'Ana', customerEmail: 'a@x', customerPhone: null, notes: null, partySize: 1, depositPence: null, paymentStatus: null },
            { id: 3, kind: 'appointment', status: 'cancelled', startsAt: new Date('2026-10-22T09:00:00Z'), endsAt: new Date('2026-10-22T10:00:00Z'), what: 'Colour', customerName: 'Tom', customerEmail: 't@x', customerPhone: null, notes: null, partySize: 1, depositPence: null, paymentStatus: null },
        ],
        sessions: [{ id: 7, title: 'Vinyasa', status: 'scheduled', startsAt: new Date('2026-10-21T17:00:00Z'), endsAt: new Date('2026-10-21T18:00:00Z'), resourceName: 'Sarah', capacity: 12, taken: 1, people: ['Ana'] }],
    });
    assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n') && body.endsWith('END:VCALENDAR\r\n'));
    assert.ok(body.includes('X-WR-CALNAME:Willowbrook\\, Salon — bookings'));
    assert.ok(body.includes('UID:owner-booking-1@bemoreswan.com') && body.includes('STATUS:TENTATIVE') && body.includes('(to confirm)'));
    assert.ok(body.includes('sam@example.com') && body.includes('£10 deposit paid'));
    assert.ok(!body.includes('owner-booking-2@'), 'a class place appears as its session, not on its own');
    assert.ok(body.includes('UID:owner-session-7@bemoreswan.com') && body.includes('Vinyasa with Sarah — 1/12 booked') && body.includes('Booked: Ana'));
    assert.ok(body.includes('Cancelled: Colour — Tom') && body.includes('STATUS:CANCELLED'));
    assert.ok(body.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75), 'lines folded at 75 octets');
});
check('folding never splits a character', () => {
    const line = `DESCRIPTION:${'é'.repeat(60)}`;
    assert.strictEqual(fold(line).replace(/\r\n /g, ''), line);
});
check('the feed is served only for a valid token; the sync runs every 15 minutes', () => {
    const fn = read('netlify/functions/booking-calendar-feed.ts');
    assert.ok(fn.indexOf('if (!FEED_TOKEN_RE.test(token)) return notFound();') < fn.indexOf('getDb()'));
    assert.ok(read('netlify.toml').includes('[functions.sync-busy-calendars]\n  schedule = "*/15 * * * *"'));
    assert.ok(read('netlify.toml').includes('from = "/api/bookings/calendar.ics"'));
    const ui = read('assets.html');
    assert.ok(ui.includes('id="cal-feed"') && ui.includes('id="cal-busy"') && ui.includes('data-rcal-save'));
});

console.log(`\n${passed}/${total} passed\n`);
