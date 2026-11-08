// tests/booking-meeting.test.ts
// Where a booking happens (docs/booking-calendly-gaps-plan.md B step 1): the checks on what may be
// saved, the link copied onto a new booking, what the customer and the owner are told, the invite,
// and the wiring (SQL, schema, settings, products, emails, calendars, chat).
//
// Run:  npx tsx tests/booking-meeting.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    cleanMeetingLocation, cleanMeetingUrl, customerMeetingHtml, icsMeeting, meetingForNewBooking, meetingLocationOf, ownerMeetingLine,
} from '../src/utils/booking-meeting';
import { cleanBookingSettings, cleanResource, settingsFromRow } from '../src/utils/booking-settings';
import { bookingIcs, type BookingRow } from '../src/utils/bookings';
import { eventForBooking } from '../src/utils/calendar-microsoft';
import { buildOwnerFeed } from '../src/utils/booking-calendar-feed';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

check('a service is in person unless it says phone or video', () => {
    assert.deepStrictEqual(cleanMeetingLocation(''), { ok: true, value: null });
    assert.deepStrictEqual(cleanMeetingLocation('in_person'), { ok: true, value: null });
    assert.deepStrictEqual(cleanMeetingLocation('video'), { ok: true, value: 'video' });
    assert.deepStrictEqual(cleanMeetingLocation('phone'), { ok: true, value: 'phone' });
    assert.strictEqual(cleanMeetingLocation('zoom').ok, false);
    assert.strictEqual(meetingLocationOf(null), 'in_person');
    assert.strictEqual(meetingLocationOf('nonsense'), 'in_person');
});

check('a meeting link must be https with a real host and no password', () => {
    assert.deepStrictEqual(cleanMeetingUrl(''), { ok: true, value: null });
    assert.deepStrictEqual(cleanMeetingUrl(null), { ok: true, value: null });
    assert.deepStrictEqual(cleanMeetingUrl('  https://zoom.us/j/123456?pwd=abc  '), { ok: true, value: 'https://zoom.us/j/123456?pwd=abc' });
    assert.ok(cleanMeetingUrl('https://meet.google.com/abc-defg-hij').ok);
    for (const bad of ['http://zoom.us/j/1', 'javascript:alert(1)', 'zoom.us/j/1', 'https://localhost/x', 'https://user:pw@zoom.us/j/1', 'https://intranet/x', `https://zoom.us/${'a'.repeat(600)}`, 'https://zoom.us/j 1', 42]) {
        assert.strictEqual(cleanMeetingUrl(bad).ok, false, String(bad));
    }
});

check('settings and people save a meeting link through the same check', () => {
    const ok = cleanBookingSettings({ meetingUrl: 'https://zoom.us/j/1' });
    assert.ok(ok.ok && ok.value.meetingUrl === 'https://zoom.us/j/1');
    assert.ok(cleanBookingSettings({ meetingUrl: '' }).ok);
    assert.strictEqual(cleanBookingSettings({ meetingUrl: 'http://x.com' }).ok, false);
    const r = cleanResource({ meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x' }, true);
    assert.ok(r.ok && r.value.meetingUrl);
    assert.strictEqual(cleanResource({ meetingUrl: 'ftp://x.com' }, true).ok, false);
    assert.strictEqual(settingsFromRow({ meetingUrl: 'https://zoom.us/j/1' }).meetingUrl, 'https://zoom.us/j/1');
    assert.strictEqual(settingsFromRow({}).meetingUrl, null);
});

check('a new booking copies the location, and for video the person\'s link before the business\'s', () => {
    const st = { meetingUrl: 'https://zoom.us/j/business' };
    assert.deepStrictEqual(meetingForNewBooking({ meetingLocation: 'video' }, { meetingUrl: 'https://zoom.us/j/sarah' }, st), { meetingLocation: 'video', meetingUrl: 'https://zoom.us/j/sarah' });
    assert.deepStrictEqual(meetingForNewBooking({ meetingLocation: 'video' }, { meetingUrl: null }, st), { meetingLocation: 'video', meetingUrl: 'https://zoom.us/j/business' });
    assert.deepStrictEqual(meetingForNewBooking({ meetingLocation: 'video' }, null, { meetingUrl: null }), { meetingLocation: 'video', meetingUrl: null });
    assert.deepStrictEqual(meetingForNewBooking({ meetingLocation: 'phone' }, null, st), { meetingLocation: 'phone', meetingUrl: null });
    assert.deepStrictEqual(meetingForNewBooking({ meetingLocation: null }, null, st), { meetingLocation: 'in_person', meetingUrl: null });
    assert.deepStrictEqual(meetingForNewBooking(null, null, st), { meetingLocation: null, meetingUrl: null });
});

const V = { status: 'confirmed', meetingLocation: 'video', meetingUrl: 'https://zoom.us/j/1', customerPhone: null };
check('the customer gets the link only once confirmed', () => {
    assert.ok(customerMeetingHtml(V, 'Willow').includes('href="https://zoom.us/j/1"'));
    const pending = customerMeetingHtml({ ...V, status: 'pending' }, 'Willow');
    assert.ok(!pending.includes('zoom.us') && pending.includes('once it\'s confirmed'));
    assert.ok(customerMeetingHtml({ ...V, meetingUrl: null }, 'Willow').includes('Willow will send you the link'));
    assert.ok(customerMeetingHtml({ ...V, meetingLocation: 'phone', customerPhone: '07700 900123' }, 'Willow').includes('call you on 07700 900123'));
    assert.strictEqual(customerMeetingHtml({ ...V, meetingLocation: 'in_person' }, 'Willow'), '');
    assert.ok(customerMeetingHtml({ ...V, meetingUrl: 'https://x.com/"><script>' }, 'W<b>').includes('&lt;script&gt;'), 'escaped');
});

check('the owner always sees how it happens', () => {
    assert.strictEqual(ownerMeetingLine(V), 'Video call: https://zoom.us/j/1');
    assert.ok(ownerMeetingLine({ ...V, meetingUrl: null }).includes('no link yet'));
    assert.strictEqual(ownerMeetingLine({ ...V, meetingLocation: 'phone', customerPhone: '07700' }), 'Phone call — call them on 07700');
    assert.strictEqual(ownerMeetingLine({ ...V, meetingLocation: null }), '');
});

const ROW = { id: 41, kind: 'consultation', status: 'confirmed', startsAt: new Date('2026-10-16T09:00:00Z'), endsAt: new Date('2026-10-16T09:45:00Z'), partySize: 1,
    serviceName: 'Strategy call', resourceName: null, customerName: 'Sam', customerEmail: 's@x.com', customerPhone: null, notes: null,
    depositPence: null, paymentStatus: null, meetingLocation: 'video', meetingUrl: 'https://zoom.us/j/1' } as unknown as BookingRow;

check('the invite carries the link as its location and URL', () => {
    assert.deepStrictEqual(icsMeeting(V), { location: 'https://zoom.us/j/1', url: 'https://zoom.us/j/1' });
    assert.deepStrictEqual(icsMeeting({ ...V, status: 'pending' }), { location: 'Video call', url: null });
    const ics = bookingIcs(ROW, 'Willow');
    assert.ok(ics.includes('LOCATION:https://zoom.us/j/1') && ics.includes('URL:https://zoom.us/j/1') && ics.includes('Join the video call'));
    const inPerson = bookingIcs({ ...ROW, meetingLocation: null, meetingUrl: null } as BookingRow, 'Willow');
    assert.ok(!inPerson.includes('LOCATION:') && !inPerson.includes('URL:'));
});

check('the owner\'s calendars (Outlook and the subscribe link) show it', () => {
    const ev = eventForBooking({ ...ROW, startsAt: new Date(ROW.startsAt), endsAt: new Date(ROW.endsAt) }, 'Strategy call');
    assert.ok(ev.body.includes('Video call: https://zoom.us/j/1'));
    const feed = buildOwnerFeed({ business: 'Willow', now: new Date('2026-10-15T00:00:00Z'), sessions: [], bookings: [{
        id: 41, kind: 'consultation', status: 'confirmed', startsAt: new Date(ROW.startsAt), endsAt: new Date(ROW.endsAt), what: 'Strategy call',
        customerName: 'Sam', customerEmail: 's@x.com', customerPhone: null, notes: null, partySize: 1, depositPence: null, paymentStatus: null,
        meetingLocation: 'video', meetingUrl: 'https://zoom.us/j/1' }] });
    assert.ok(feed.replace(/\r\n /g, '').includes('Video call: https://zoom.us/j/1'));
});

check('wiring: SQL, schema, booking, emails, saves, chat', () => {
    const sqlFile = read('db/z-booking-meeting-links.sql');
    for (const c of ['org_products       ADD COLUMN IF NOT EXISTS meeting_location', 'booking_settings   ADD COLUMN IF NOT EXISTS meeting_url', 'bookable_resources ADD COLUMN IF NOT EXISTS meeting_url', 'bookings           ADD COLUMN IF NOT EXISTS meeting_location', 'bookings           ADD COLUMN IF NOT EXISTS meeting_url']) assert.ok(sqlFile.includes(c), c);
    const schema = read('db/schema.ts');
    assert.ok(schema.includes('meetingLocation: text("meeting_location")') && schema.includes('meetingUrl: text("meeting_url")'));
    const bookings = read('src/utils/bookings.ts');
    assert.ok(bookings.includes('meetingForNewBooking(service, resource, setup.settings)'), 'copied when made');
    assert.ok(bookings.includes('customerMeetingHtml(b, ctx.business)'), 'in the customer emails (incl. the reminder)');
    assert.ok(read('src/utils/site-booking.ts').includes("meetingLocationOf(chosen.meetingLocation) === 'phone'"), 'a phone call needs a number, checked on the server');
    assert.ok(read('netlify/functions/org-products.ts').includes('cleanMeetingLocation(body.meetingLocation)'));
    assert.ok(read('netlify/functions/booking-settings.ts').includes('refreshMeetingLinks'), 'a changed link reaches upcoming bookings');
    assert.ok(read('netlify/functions/sites.ts').includes('cleanMeetingLocation(o.location)'), 'chat card sets where services happen');
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"serviceLocations":[{"serviceId"'));
    assert.ok(read('assets.html').includes('id="op-meeting"') && read('assets.html').includes('id="bh-meeting"') && read('assets.html').includes('data-rmeet'));
});

console.log(`\n${passed}/${total} passed`);
