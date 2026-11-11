// tests/booking-meeting-providers.test.ts
// docs/booking-calendly-gaps-plan.md B step 2 + C + the small items: a Teams meeting per booking
// (calendar-microsoft.ts), the Google calendar sign-in and Meet links (calendar-google.ts), online
// class links, the booking link's QR code, and the Website "Needs you" banner naming what waits.
//
// Run:  npx tsx tests/booking-meeting-providers.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wantsOwnMeeting } from '../src/utils/booking-meeting';
import { cleanBookingSettings, settingsFromRow } from '../src/utils/booking-settings';
import { eventForBooking, wantedHash } from '../src/utils/calendar-microsoft';
import { busyFromGoogle, GOOGLE_CALENDAR_SCOPE, googleCalendarAvailable, googleEventJson, meetLinkOf } from '../src/utils/calendar-google';
import { cleanNewSessions } from '../src/utils/class-sessions';
import { bookingQrSvg } from '../src/utils/site-booking-page';
import { timetableHtml } from '../src/utils/site-render';

let passed = 0;
let total = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>): void {
    total++;
    const done = (ok: boolean, err?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; } };
    try { const r = fn(); if (r instanceof Promise) pending.push(r.then(() => done(true), (e) => done(false, e))); else done(true); }
    catch (err) { done(false, err); }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

check('how video links are made: link (default), teams or meet — anything else refused', () => {
    assert.strictEqual(settingsFromRow({}).meetingProvider, 'link');
    assert.strictEqual(settingsFromRow({ meetingProvider: 'teams' }).meetingProvider, 'teams');
    assert.strictEqual(settingsFromRow({ meetingProvider: 'zoom' }).meetingProvider, 'link');
    const t = cleanBookingSettings({ meetingProvider: 'teams' });
    assert.ok(t.ok && t.value.meetingProvider === 'teams' && t.value.meetingProviderError === null, 'a fresh choice clears the last problem');
    const l = cleanBookingSettings({ meetingProvider: 'link' });
    assert.ok(l.ok && l.value.meetingProvider === null, 'link is stored as NULL');
    assert.strictEqual(cleanBookingSettings({ meetingProvider: 'zoom' }).ok, false);
});

const B = { meetingLocation: 'video', status: 'confirmed', meetingSource: null, kind: 'consultation' };
check('a meeting of its own only for a CONFIRMED video booking, once, never a class place', () => {
    assert.strictEqual(wantsOwnMeeting(B, 'teams'), true);
    assert.strictEqual(wantsOwnMeeting(B, 'meet'), true);
    assert.strictEqual(wantsOwnMeeting(B, 'link'), false);
    assert.strictEqual(wantsOwnMeeting(B, null), false);
    assert.strictEqual(wantsOwnMeeting({ ...B, status: 'pending' }, 'teams'), false, 'a request gets none until confirmed');
    assert.strictEqual(wantsOwnMeeting({ ...B, meetingSource: 'teams' }, 'teams'), false, 'made once');
    assert.strictEqual(wantsOwnMeeting({ ...B, meetingLocation: 'phone' }, 'teams'), false);
    assert.strictEqual(wantsOwnMeeting({ ...B, kind: 'class' }, 'teams'), false, 'a class shares its session link');
});

const ROW = { id: 7, status: 'confirmed', startsAt: new Date('2026-11-20T10:00:00Z'), endsAt: new Date('2026-11-20T10:30:00Z'), customerName: 'Sam', customerEmail: 's@x.com',
    customerPhone: null, notes: null, partySize: 1, kind: 'consultation', depositPence: null, paymentStatus: null, meetingLocation: 'video', meetingUrl: 'https://zoom.us/j/1' };

check('Outlook: a Teams booking\'s event asks for a Teams meeting, and storing the link changes nothing', () => {
    const plain = eventForBooking(ROW, 'Strategy call');
    assert.ok(!plain.online && plain.body.includes('Video call: https://zoom.us/j/1'));
    const teams = eventForBooking({ ...ROW, meetingSource: 'teams', meetingUrl: null }, 'Strategy call');
    assert.strictEqual(teams.online, true);
    assert.ok(teams.body.includes('the Teams meeting in this event'));
    const withLink = eventForBooking({ ...ROW, meetingSource: 'teams', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x' }, 'Strategy call');
    assert.strictEqual(wantedHash(teams), wantedHash(withLink), 'no second write after the link is stored');
    assert.notStrictEqual(wantedHash(plain), wantedHash(teams));
    const ms = read('src/utils/calendar-microsoft.ts');
    assert.ok(ms.includes("isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness'"));
    assert.ok(ms.includes('export async function teamsMeetingFor('));
});

check('the link is made BEFORE the customer is emailed, at every confirmation', () => {
    const bookings = read('src/utils/bookings.ts');
    const announce = bookings.slice(bookings.indexOf('export async function announceNewBooking'));
    assert.ok(announce.indexOf('ensureMeetingLink(db, b)') > -1 && announce.indexOf('ensureMeetingLink(db, b)') < announce.indexOf('await emailCustomer('), 'instant bookings');
    const decide = bookings.slice(bookings.indexOf('export async function decideBooking'));
    assert.ok(decide.indexOf("if (action === 'confirm') row = await ensureMeetingLink(db, row);") > -1 && decide.indexOf('ensureMeetingLink') < decide.indexOf('await emailCustomer('), 'the owner\'s Confirm');
    assert.ok(read('src/utils/site-booking.ts').includes('made.booking = await ensureMeetingLink(b.db, made.booking);'), 'a move');
    assert.ok(read('netlify/functions/send-booking-reminders.ts').includes('ensureMeetingLink(db, b as BookingRow)'), 'one more try at the reminder');
    const meeting = read('src/utils/booking-meeting.ts');
    assert.ok(meeting.includes("AND (bk.meeting_source IS NULL OR bk.meeting_source = 'link')") && meeting.includes("AND bk.kind <> 'class'"), 'a changed pasted link never overwrites a made meeting or a class link');
    assert.ok(meeting.includes('ONLINE_MEETING_TIMEOUT_MS'), 'a slow calendar never holds up the booking');
});

check('Google: busy times skip free, cancelled and our own events; all-day only when busy', () => {
    const busy = busyFromGoogle([
        { start: { dateTime: '2026-11-20T09:00:00Z' }, end: { dateTime: '2026-11-20T10:00:00Z' } },
        { start: { dateTime: '2026-11-20T11:00:00Z' }, end: { dateTime: '2026-11-20T12:00:00Z' }, transparency: 'transparent' },
        { start: { dateTime: '2026-11-20T13:00:00Z' }, end: { dateTime: '2026-11-20T14:00:00Z' }, status: 'cancelled' },
        { start: { dateTime: '2026-11-20T15:00:00Z' }, end: { dateTime: '2026-11-20T16:00:00Z' }, extendedProperties: { private: { bms: '58-b:1' } } },
        { start: { date: '2026-11-21' }, end: { date: '2026-11-22' } },
        { start: { date: '2026-11-23' }, end: { date: '2026-11-24' }, transparency: 'transparent' },
        { start: { dateTime: 'nonsense' }, end: { dateTime: '2026-11-20T16:00:00Z' } },
    ]);
    assert.deepStrictEqual(busy.map((b) => b.start.toISOString()), ['2026-11-20T09:00:00.000Z', '2026-11-21T00:00:00.000Z']);
});

check('Google: our events are marked, and a Meet is asked for only when wanted', () => {
    const w = { key: 'b:7', subject: 'Call — Sam', body: 'x', start: ROW.startsAt, end: ROW.endsAt, tentative: false };
    const plain = googleEventJson(w, 58) as Record<string, unknown>;
    assert.deepStrictEqual(plain.extendedProperties, { private: { bms: '58-b:7' } });
    assert.ok(!('conferenceData' in plain));
    const meet = googleEventJson({ ...w, online: true }, 58) as { conferenceData: { createRequest: { requestId: string; conferenceSolutionKey: { type: string } } } };
    assert.strictEqual(meet.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
    assert.strictEqual(meet.conferenceData.createRequest.requestId, 'bms-58-b:7', 'the same request id each time: one Meet, not one per write');
    assert.strictEqual(meetLinkOf({ hangoutLink: 'https://meet.google.com/abc-defg-hij' }), 'https://meet.google.com/abc-defg-hij');
    assert.strictEqual(meetLinkOf({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+44' }, { entryPointType: 'video', uri: 'https://meet.google.com/x-y-z' }] } }), 'https://meet.google.com/x-y-z');
    assert.strictEqual(meetLinkOf({ hangoutLink: 'https://evil.example/meet' }), null);
    assert.strictEqual(meetLinkOf(null), null);
});

check('Google: the narrowest scopes, its own project, offered only where configured, one calendar at a time', () => {
    assert.strictEqual(GOOGLE_CALENDAR_SCOPE, 'openid email https://www.googleapis.com/auth/calendar.events');
    assert.strictEqual(googleCalendarAvailable({}), false);
    assert.strictEqual(googleCalendarAvailable({ GOOGLE_CALENDAR_CLIENT_ID: 'a' }), false);
    assert.strictEqual(googleCalendarAvailable({ GOOGLE_CALENDAR_CLIENT_ID: 'a', GOOGLE_CALENDAR_CLIENT_SECRET: 'b' }), true);
    const oauth = read('netlify/functions/oauth-integrations.ts');
    assert.ok(oauth.includes('google_calendar: GOOGLE_CALENDAR_SCOPE'));
    assert.ok(oauth.includes("calendar_already_connected"), 'one signed-in calendar at a time');
    assert.ok(oauth.includes("if (provider === 'google_calendar') await forgetGoogle(db, ctx.organisationId);"));
    assert.ok(oauth.includes('process.env.GOOGLE_CALENDAR_CLIENT_ID'), 'its own Google Cloud project, not YouTube or Gmail');
    const wi = read('src/utils/workspace-integrations.ts');
    assert.ok(wi.includes("'google_calendar'") && wi.includes("google_calendar: 'Google calendar'"));
    assert.ok(read('netlify/functions/sync-busy-calendars.ts').includes('syncGoogle(db, orgId, new Date())'));
    assert.ok(read('netlify/functions/booking-settings.ts').includes('google: { available: googleCalendarAvailable()'));
    assert.ok(read('assets.html').includes('/api/oauth/google_calendar/connect?returnTo=bookings'));
    assert.ok(!/google calendar/i.test(read('connections.html')), 'not claimed on the public connections page before Google approves it');
});

check('online classes: a checked link on the session, copied onto each place, "online" on the timetable', () => {
    const base = { serviceId: 4, date: '2099-01-05', start: '18:00', end: '19:00', capacity: 10 };
    const ok = cleanNewSessions({ ...base, meetingUrl: 'https://zoom.us/j/9' }, '2026-11-11');
    assert.ok(ok.ok && ok.value.meetingUrl === 'https://zoom.us/j/9');
    const none = cleanNewSessions(base, '2026-11-11');
    assert.ok(none.ok && none.value.meetingUrl === null);
    assert.strictEqual(cleanNewSessions({ ...base, meetingUrl: 'http://zoom.us/j/9' }, '2026-11-11').ok, false);
    assert.ok(read('src/utils/class-sessions.ts').includes("...(s.meetingUrl ? { meetingLocation: 'video', meetingUrl: s.meetingUrl } : {}),"));
    const html = timetableHtml([{ id: 1, title: 'Yoga', serviceId: 4, resourceName: null, startsAt: '', endsAt: '', date: '2026-11-20', dateText: 'Friday 20 November', timeText: '6pm–7pm', capacity: 10, taken: 0, left: 10, status: 'scheduled', seriesKey: null, price: null, online: true }], 'cl1');
    assert.ok(html.includes('· online') && !html.includes('zoom'), 'the link itself never on the public page');
    assert.ok(read('src/components/assistant-site-editor.js').includes('data-sf="meetingUrl"'));
});

check('the booking link as a QR code', async () => {
    const svg = await bookingQrSvg('https://willow.bemoreswan.site/book');
    assert.ok(svg && svg.startsWith('<svg') && svg.includes('viewBox'));
    assert.ok(read('src/components/assistant-site-editor.js').includes('download="booking-link-qr.svg"'));
});

check('the Website banner names what is waiting, not always "Enquiries"', () => {
    const a = read('assistants.js');
    assert.ok(a.includes('const ownWhere = ownItems.length ?'));
    assert.ok(a.includes('const where = own ? (ownWhere || own.where)'));
    assert.ok(a.includes('ownItems.length === 1 && ownItems[0].tab ? ownItems[0].tab : own.tab'), 'and its button opens that tab');
});

check('SQL + schema', () => {
    const sqlFile = read('db/z-booking-meeting-providers.sql');
    for (const c of ['booking_settings ADD COLUMN IF NOT EXISTS meeting_provider ', 'booking_settings ADD COLUMN IF NOT EXISTS meeting_provider_error', 'bookings         ADD COLUMN IF NOT EXISTS meeting_source', 'class_sessions   ADD COLUMN IF NOT EXISTS meeting_url']) assert.ok(sqlFile.includes(c), c);
    const schema = read('db/schema.ts');
    assert.ok(schema.includes('meetingProvider: text("meeting_provider")') && schema.includes('meetingSource: text("meeting_source")') && schema.includes('meetingProviderError: text("meeting_provider_error")'));
});

Promise.all(pending).then(() => console.log(`\n${passed}/${total} passed`));
