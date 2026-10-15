// tests/bookings.test.ts
// Bookings, phase 1 (docs/booking-plan.md): time zones (booking-time.ts), which times can be booked
// (booking-availability.ts), what may be saved (booking-settings.ts), the booking steps on a site
// (site-booking.ts), the booking section, and the wiring that keeps a slot from being taken twice.
//
// Run:  npx tsx tests/bookings.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, dayOf, formatDate, formatTime, tzOffsetMinutes, utcToZoned, zonedToUtc } from '../src/utils/booking-time';
import { availableSlots, bookableDates, dateIsBookable, type AvailabilitySettings, type AvailabilityResource } from '../src/utils/booking-availability';
import { cleanBookingSettings, cleanClosures, cleanResource, cleanWeeklyHours, describeHours, settingsFromRow, BOOKING_DEFAULTS } from '../src/utils/booking-settings';
import { bookingIcs, describeBooking, type BookingRow } from '../src/utils/bookings';
import { bookLink, readChoice } from '../src/utils/site-booking';
import { normaliseSiteDefinition, SECTION_TYPES } from '../src/utils/site-definition';
import { renderSitePage, BOOK_PATH } from '../src/utils/site-render';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';
import { WORKSPACE_TABLES } from '../src/utils/workspace-export';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const S: AvailabilitySettings = {
    timezone: 'Europe/London',
    weeklyHours: { fri: [{ start: '09:00', end: '12:00' }], sat: [{ start: '09:00', end: '11:00' }, { start: '18:00', end: '21:00' }] },
    closures: [{ date: '2026-10-23' }],
    minNoticeMinutes: 120, maxAdvanceDays: 60, slotIntervalMinutes: 30, bufferMinutes: 0, tableMinutes: 90, maxPartySize: 8,
};
const NOW = new Date('2026-10-15T08:00:00Z');          // Thursday, 9am in London
const SARAH: AvailabilityResource = { id: 1, name: 'Sarah', capacity: 1, weeklyHours: null, serviceIds: null };
const MARK: AvailabilityResource = { id: 2, name: 'Mark', capacity: 1, weeklyHours: { fri: [{ start: '10:00', end: '12:00' }] }, serviceIds: [7] };
const appt = (over: Record<string, unknown> = {}) => ({ date: '2026-10-16', kind: 'appointment' as const, durationMinutes: 45, serviceId: 5, resourceId: null, partySize: 1, now: NOW, ...over });

console.log('\nTime zones');

check('wall-clock times become the right instant, across the clocks going back', () => {
    assert.strictEqual(zonedToUtc('2026-10-24', '09:00', 'Europe/London').toISOString(), '2026-10-24T08:00:00.000Z', 'British Summer Time');
    assert.strictEqual(zonedToUtc('2026-10-25', '09:00', 'Europe/London').toISOString(), '2026-10-25T09:00:00.000Z', 'Greenwich Mean Time');
    assert.strictEqual(zonedToUtc('2026-10-16', '09:00', 'Europe/Athens').toISOString(), '2026-10-16T06:00:00.000Z');
    assert.deepStrictEqual(utcToZoned(new Date('2026-10-16T08:30:00Z'), 'Europe/London'), { date: '2026-10-16', time: '09:30', day: 'fri' });
    assert.strictEqual(tzOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'Europe/London'), 60);
});

check('dates and times read the way a customer reads them', () => {
    assert.strictEqual(dayOf('2026-10-16'), 'fri');
    assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
    assert.strictEqual(formatDate('2026-10-16'), 'Friday 16 October');
    assert.strictEqual(formatTime('09:30'), '9:30am');
    assert.strictEqual(formatTime('14:00'), '2pm');
    assert.strictEqual(formatTime('00:15'), '12:15am');
});

console.log('\nWhich times can be booked');

check('only open days inside the booking window, never a closed day', () => {
    assert.ok(dateIsBookable(S, '2026-10-16', NOW));
    assert.ok(!dateIsBookable(S, '2026-10-15', NOW), 'closed on Thursdays');
    assert.ok(!dateIsBookable(S, '2026-10-23', NOW), 'a closed day');
    assert.ok(!dateIsBookable(S, '2026-10-14', NOW), 'in the past');
    assert.ok(!dateIsBookable(S, '2027-01-08', NOW), 'beyond how far ahead people can book');
    assert.deepStrictEqual(bookableDates(S, NOW, 3), ['2026-10-16', '2026-10-17', '2026-10-24']);
});

check('a booking blocks every time it overlaps; the service must fit before closing', () => {
    const taken = [{ resourceId: 1, startsAt: new Date('2026-10-16T09:00:00Z'), endsAt: new Date('2026-10-16T09:45:00Z'), partySize: 1 }];
    const times = availableSlots(S, [SARAH], taken, appt()).map((x) => x.time);
    assert.deepStrictEqual(times, ['09:00', '11:00'], '9:30, 10:00, 10:30 overlap 10:00–10:45; 11:30 would run past noon');
});

check('the notice needed is respected', () => {
    const sameDay = availableSlots({ ...S, weeklyHours: { thu: [{ start: '09:00', end: '17:00' }] } }, [], [], appt({ date: '2026-10-15' })).map((x) => x.time);
    assert.strictEqual(sameDay[0], '11:00', 'now 9am + 2 hours');
});

check('a gap between bookings keeps the times either side free', () => {
    const taken = [{ resourceId: 1, startsAt: new Date('2026-10-16T09:00:00Z'), endsAt: new Date('2026-10-16T09:45:00Z'), partySize: 1 }];
    // The 10:00–10:45 booking: a 15-minute gap still leaves 9:00 (ends 9:45) and 11:00 free; 30 minutes takes both.
    assert.deepStrictEqual(availableSlots({ ...S, bufferMinutes: 15 }, [SARAH], taken, appt()).map((x) => x.time), ['09:00', '11:00']);
    assert.deepStrictEqual(availableSlots({ ...S, bufferMinutes: 30 }, [SARAH], taken, appt()).map((x) => x.time), []);
});

check('"anyone available" uses whoever is free; staff hours and the services they do are respected', () => {
    const taken = [{ resourceId: 1, startsAt: new Date('2026-10-16T09:00:00Z'), endsAt: new Date('2026-10-16T09:45:00Z'), partySize: 1 }];
    const slots = availableSlots(S, [SARAH, MARK], taken, appt({ serviceId: 7 }));
    const ten = slots.find((x) => x.time === '10:00')!;
    assert.deepStrictEqual(ten.resourceIds, [2], 'Sarah is busy at 10, Mark is working and does service 7');
    assert.deepStrictEqual(slots.find((x) => x.time === '09:00')!.resourceIds, [1], 'Mark starts at 10');
    assert.ok(!availableSlots(S, [SARAH, MARK], [], appt({ serviceId: 5 })).some((x) => x.resourceIds.includes(2)), 'Mark does not do service 5');
    assert.ok(availableSlots(S, [SARAH, MARK], [], appt({ resourceId: 2, serviceId: 7 })).every((x) => x.resourceIds.join() === '2'), 'a chosen person only');
});

check('just the owner: one booking at a time', () => {
    const taken = [{ resourceId: null, startsAt: new Date('2026-10-16T08:00:00Z'), endsAt: new Date('2026-10-16T08:45:00Z'), partySize: 1 }];
    assert.ok(!availableSlots(S, [], taken, appt()).some((x) => x.time === '09:00'));
});

check('tables: seats add up to the area\'s capacity; a party larger than the area or the limit is refused', () => {
    const TERRACE: AvailabilityResource = { id: 9, name: 'Terrace', capacity: 10, weeklyHours: null, serviceIds: null };
    const q = { date: '2026-10-17', kind: 'table' as const, durationMinutes: 0, serviceId: null, resourceId: null, now: NOW };
    const taken = [{ resourceId: 9, startsAt: new Date('2026-10-17T17:00:00Z'), endsAt: new Date('2026-10-17T18:30:00Z'), partySize: 6 }];
    assert.ok(availableSlots(S, [TERRACE], taken, { ...q, partySize: 4 }).some((x) => x.time === '18:00'), '6 + 4 = 10 fits');
    assert.ok(!availableSlots(S, [TERRACE], taken, { ...q, partySize: 5 }).some((x) => x.time === '18:00'), '6 + 5 does not');
    assert.deepStrictEqual(availableSlots(S, [TERRACE], [], { ...q, partySize: 9 }), [], 'over the online limit of 8');
    assert.deepStrictEqual(availableSlots({ ...S, maxPartySize: 20 }, [TERRACE], [], { ...q, partySize: 12 }), [], 'bigger than the area');
    assert.ok(availableSlots(S, [], [], { ...q, partySize: 4 }).length > 0, 'no tables set up: requests go to the owner');
    const evening = availableSlots(S, [TERRACE], [], { ...q, partySize: 2 }).map((x) => x.time);
    assert.ok(evening.includes('09:00') && evening.includes('19:30') && !evening.includes('20:00'), 'both opening periods; 90 minutes must fit before 9pm');
});

console.log('\nWhat may be saved');

check('opening hours: real times, closing after opening, no overlaps, up to three periods', () => {
    assert.deepStrictEqual(cleanWeeklyHours({ mon: [{ start: '09:00', end: '17:00' }], tue: [] }), { ok: true, value: { mon: [{ start: '09:00', end: '17:00' }] } });
    assert.match((cleanWeeklyHours({ mon: [{ start: '9am', end: '5pm' }] }) as { error: string }).error, /like 09:00/);
    assert.match((cleanWeeklyHours({ mon: [{ start: '17:00', end: '09:00' }] }) as { error: string }).error, /after the opening/);
    assert.match((cleanWeeklyHours({ mon: [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '17:00' }] }) as { error: string }).error, /overlap/);
    assert.match((cleanWeeklyHours({ mon: Array.from({ length: 4 }, (_, i) => ({ start: `0${i}:00`, end: `0${i}:30` })) }) as { error: string }).error, /up to 3/);
});

check('rules are bounded; closed days are dates; a resource needs a name', () => {
    assert.ok(cleanBookingSettings({ slotIntervalMinutes: 30, mode: 'instant', timezone: 'Europe/London' }).ok);
    assert.ok(!cleanBookingSettings({ slotIntervalMinutes: 7 }).ok);
    assert.ok(!cleanBookingSettings({ timezone: 'Mars/Olympus' }).ok);
    assert.ok(!cleanBookingSettings({ maxPartySize: 0 }).ok);
    assert.ok(!cleanClosures([{ date: 'Christmas' }]).ok);
    assert.ok(!cleanResource({ name: '  ' }, false).ok);
    const r = cleanResource({ name: 'Terrace', kind: 'table', capacity: 30, serviceIds: [] }, false);
    assert.ok(r.ok && r.value.serviceIds === null, 'none ticked = every service');
    assert.deepStrictEqual(settingsFromRow(null), BOOKING_DEFAULTS);
});

check('hours in plain words', () => {
    const h = { mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }], wed: [{ start: '09:00', end: '17:00' }], sat: [{ start: '10:00', end: '13:30' }] };
    assert.strictEqual(describeHours(h), 'Mon–Wed 9am–5pm; Sat 10am–1:30pm');
    assert.strictEqual(describeHours({}), 'No opening hours set');
});

console.log('\nThe booking, in words and in a calendar');

const ROW = { id: 41, kind: 'appointment', startsAt: new Date('2026-10-16T09:00:00Z'), endsAt: new Date('2026-10-16T09:45:00Z'), partySize: 1, serviceName: 'Cut & blow-dry', resourceName: 'Elena', customerName: 'Sam' } as unknown as BookingRow;
check('described in the business\'s own time; the invite is a valid calendar entry', () => {
    assert.deepStrictEqual(describeBooking(ROW, 'Europe/London'), { when: 'Friday 16 October, 10am–10:45am', what: 'Cut & blow-dry with Elena' });
    const ics = bookingIcs(ROW, 'Willowbrook, Salon');
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.includes('DTSTART:20261016T090000Z') && ics.includes('DTEND:20261016T094500Z'));
    assert.ok(ics.includes('SUMMARY:Cut & blow-dry with Elena — Willowbrook\\, Salon'), 'commas escaped');
    assert.ok(ics.includes('UID:booking-41@'));
});

console.log('\nOn the website');

check('the booking section: a GET doorway to /_book — nothing is held until the last step', () => {
    assert.ok(SECTION_TYPES.includes('booking'));
    const d = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'booking', props: { kind: 'appointment', askStaff: true } }] }] }).definition;
    const ready = { ready: true, services: [{ id: 5, name: 'Cut', price: '£45', durationMinutes: 45 }], maxPartySize: 8 };
    const html = renderSitePage(d, '/', { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, booking: ready }).html;
    assert.ok(html.includes(`<form class="fm" method="get" action="${BOOK_PATH}">`) && html.includes('name="svc" value="5"') && html.includes('45 min · £45'));
    const notReady = renderSitePage(d, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null, booking: { ...ready, ready: false } }).html;
    assert.ok(!notReady.includes(BOOK_PATH), 'no hours set: nothing on the live site');
    const table = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'booking', props: { kind: 'table', askStaff: true } }] }] }).definition;
    assert.strictEqual((table.pages[0].sections[0].props as { askStaff: boolean }).askStaff, false, 'tables never offer a choice of staff');
    assert.ok(renderSitePage(table, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null, booking: ready }).html.includes('name="party"'));
});

check('the steps read only what was chosen — every choice is checked again against the site and Business Information', () => {
    const c = readChoice(new URLSearchParams('s=abc&svc=5&res=any&date=2026-10-16&time=09:30&party=x&evil=1'));
    assert.deepStrictEqual(c, { s: 'abc', svc: 5, party: 0, res: 'any', date: '2026-10-16', time: '09:30', mv: null, mt: null });
    assert.deepStrictEqual(readChoice(new URLSearchParams('date=16/10/2026&time=9am')).date, null);
    assert.strictEqual(bookLink(c, { time: null }), '/_book?s=abc&svc=5&res=any&date=2026-10-16');
    const src = read('src/utils/site-booking.ts');
    assert.ok(src.includes("const svc = props.kind === 'table' ? null : services.find((x) => x.id === c.svc) ?? null;"));
    assert.ok(src.includes('kindResources.some((r) => r.id === c.res)'));
    const submit = src.slice(src.indexOf('export async function bookSubmit'));
    assert.ok(submit.indexOf("String(body.get('website')") < submit.indexOf('createBooking('), 'bots turned away first');
    assert.ok(submit.indexOf('checkRateLimit(') < submit.indexOf('createBooking('));
    assert.ok(submit.includes("if (!made.ok)") && submit.includes("q.delete('time')"), 'a time taken meanwhile → the times still free');
});

check('no double bookings: availability is recomputed inside a transaction holding the workspace lock', () => {
    const src = read('src/utils/bookings.ts');
    const fn = src.slice(src.indexOf('export async function createBooking'), src.indexOf('// ── What the booking looks like'));
    assert.ok(fn.includes('db.transaction(') && fn.includes('pg_advisory_xact_lock('));
    assert.ok(fn.indexOf('pg_advisory_xact_lock(') < fn.indexOf('slotsForDay(tx,') && fn.indexOf('slotsForDay(tx,') < fn.indexOf('tx.insert(bookings)'));
    assert.ok(fn.includes("setup.settings.mode === 'instant' ? 'confirmed' : 'pending'"));
    const taken = src.slice(src.indexOf('async function takenOn'), src.indexOf('export interface SlotRequest'));
    assert.ok(taken.includes("inArray(bookings.status, ['pending', 'confirmed'])"), 'a request holds its time too');
});

check('serving: /_book GET steps and POST — the edge forwards it, the key is checked first', () => {
    const serve = read('netlify/functions/site-serve.ts');
    assert.ok(serve.includes('path !== BOOK_PATH') && serve.includes('bookStep(') && serve.includes('bookSubmit('));
    assert.ok(read('sites-host/edge-functions/serve.ts').includes("'/_book'"));
    assert.ok(read('src/utils/site-forms.ts').includes("q.get('k') === 'booking'"));
});

console.log('\nThe owner\'s side');

check('decisions only from a state where they make sense; the customer is told', () => {
    const src = read('src/utils/bookings.ts');
    const fn = src.slice(src.indexOf('export async function decideBooking'), src.indexOf('export async function listBookings'));
    assert.ok(fn.includes("confirm: ['pending'], decline: ['pending'], cancel: ['pending', 'confirmed']"));
    assert.ok(fn.includes('eq(bookings.organisationId, orgId)') && fn.includes('emailCustomer('));
    const email = src.slice(src.indexOf('export async function emailCustomer'), src.indexOf('export async function decideBooking'));
    assert.ok(email.includes("notice === 'confirmed' ? { attachments: [{ filename: 'booking.ics'"));
    assert.ok(read('src/utils/email.ts').includes('...(attachments && attachments.length ? { attachments } : {})'));
});

check('Business Information owns hours, rules and resources; services are Products & Services with a length', () => {
    const ui = read('assets.html');
    assert.ok(ui.includes('data-tab="hours">Hours, Location &amp; Bookings') && ui.includes("const API = '/.netlify/functions/booking-settings'"));
    const api = read('netlify/functions/booking-settings.ts');
    assert.ok(api.includes('cleanBookingSettings(body)') && api.includes('cleanResource(body, false)'));
    assert.strictEqual((api.match(/eq\(bookableResources\.organisationId, orgId\)/g) || []).length, 4, 'every statement scoped');
    assert.ok(read('src/utils/bookings.ts').includes('isNotNull(orgProducts.durationMinutes)'));
});

check('editor, chat, notification, export and migration are wired', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes("booking: 'Bookings'") && ed.includes("kind: 'servicePick'") && ed.includes("action: 'booking_decide'") && ed.includes("action: 'bookings'"));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('"type":"booking_setup"') && chat.includes('never assume hours they did not give'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('booking_setup', renderBookingSetupCard)"));
    assert.ok(read('src/components/chat-session.js').includes("action: 'booking_setup'"));
    assert.strictEqual(getNotificationDefault('site_booking_received')?.type, 'site_booking_received');
    assert.ok(read('src/utils/notification-actions.ts').includes("site_booking_received: 'suggested_action'"));
    assert.ok(read('db/notifications-categorization.sql').includes("WHEN 'site_booking_received'"));
    assert.ok(WORKSPACE_TABLES.bookings && WORKSPACE_TABLES.bookingSettings && WORKSPACE_TABLES.bookableResources);
    const sql = read('db/z-bookings.sql');
    for (const t of ['booking_settings', 'bookable_resources', 'bookings']) assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`), t);
});

console.log(`\n${passed}/${total} passed`);
