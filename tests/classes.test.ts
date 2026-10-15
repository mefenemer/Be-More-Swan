// tests/classes.test.ts
// Classes and events (docs/booking-plan.md phase 5): dated sessions with places, booked as ordinary
// bookings under the same lock, a waitlist when full, a timetable on the site, and the owner's
// timetable on the Website tab. src/utils/class-sessions.ts, site-classes.ts, site-render.ts.
//
// Run:  npx tsx tests/classes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanNewSessions, CLASS_LIMITS, sessionDates, viewOf, type SessionRow, type SessionView } from '../src/utils/class-sessions';
import { normaliseSiteDefinition, type BookingProps } from '../src/utils/site-definition';
import { placesText, renderSitePage, sessionLink, timetableHtml } from '../src/utils/site-render';
import { describeBooking, type BookingRow } from '../src/utils/bookings';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nAdding dates');

check('a session needs a class, a date not past, a start before its end, and 1–500 places', () => {
    const ok = cleanNewSessions({ serviceId: '4', date: '2026-10-20', start: '18:00', end: '19:15', capacity: '12', resourceId: '', repeatWeeks: '7', notes: ' Bring a mat ' }, '2026-10-15');
    assert.ok(ok.ok);
    if (ok.ok) assert.deepStrictEqual(ok.value, { serviceId: 4, date: '2026-10-20', start: '18:00', end: '19:15', capacity: 12, resourceId: null, repeatWeeks: 7, notes: 'Bring a mat' });
    const today = '2026-10-15';
    assert.ok(!cleanNewSessions({ date: '2026-10-20', start: '18:00', end: '19:00', capacity: 5 }, today).ok, 'no class');
    assert.ok(!cleanNewSessions({ serviceId: 1, date: '2026-10-14', start: '18:00', end: '19:00', capacity: 5 }, today).ok, 'in the past');
    assert.ok(!cleanNewSessions({ serviceId: 1, date: '2026-10-20', start: '19:00', end: '18:00', capacity: 5 }, today).ok, 'ends before it starts');
    assert.ok(!cleanNewSessions({ serviceId: 1, date: '2026-10-20', start: '18:00', end: '19:00', capacity: 0 }, today).ok, 'no places');
    assert.ok(!cleanNewSessions({ serviceId: 1, date: '2026-10-20', start: '18:00', end: '19:00', capacity: 5, repeatWeeks: CLASS_LIMITS.repeatWeeks + 1 }, today).ok, 'repeats too long');
});
check('a weekly class falls on the same weekday, across month ends', () => {
    assert.deepStrictEqual(sessionDates('2026-10-20', 3), ['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10']);
    assert.deepStrictEqual(sessionDates('2026-12-01', 0), ['2026-12-01']);
});
check('times are the business\'s clock, across the October clock change', () => {
    const row = (startsAt: string, endsAt: string) => ({ id: 1, title: 'Vinyasa', serviceId: 4, resourceName: 'Sarah', startsAt: new Date(startsAt), endsAt: new Date(endsAt), capacity: 12, status: 'scheduled', seriesKey: 'k' }) as unknown as SessionRow;
    const before = viewOf(row('2026-10-20T17:00:00Z', '2026-10-20T18:00:00Z'), 9, 'Europe/London');   // BST
    const after = viewOf(row('2026-10-27T18:00:00Z', '2026-10-27T19:00:00Z'), 12, 'Europe/London');   // GMT
    assert.strictEqual(before.timeText, '6pm–7pm');
    assert.strictEqual(after.timeText, '6pm–7pm');
    assert.strictEqual(before.left, 3);
    assert.strictEqual(after.left, 0);
});

console.log('\nBooking places');

check('places are re-counted under the same lock as every booking, and never overbooked', () => {
    const src = read('src/utils/class-sessions.ts');
    const lock = src.indexOf('pg_advisory_xact_lock(hashtext(${`bookings:${orgId}`}))');
    const count = src.indexOf('const taken = (await takenBySession(tx, [s.id]))');
    const insert = src.indexOf("kind: 'class',");
    assert.ok(lock > 0 && count > lock && insert > count, 'lock → count → insert');
    assert.ok(src.includes('if (b.places > left)'));
    assert.ok(src.includes("const HELD = ['pending', 'confirmed'];"), 'a request holds its places too');
});
check('a class place reads as the class, with the places when more than one', () => {
    const b = { kind: 'class', serviceName: 'Vinyasa', resourceName: 'Sarah', partySize: 3, startsAt: new Date('2026-10-20T17:00:00Z'), endsAt: new Date('2026-10-20T18:00:00Z') } as unknown as BookingRow;
    assert.deepStrictEqual(describeBooking(b, 'Europe/London'), { when: 'Tuesday 20 October, 6pm–7pm', what: 'Vinyasa with Sarah (3 places)' });
    assert.strictEqual(describeBooking({ ...b, partySize: 1 } as BookingRow, 'Europe/London').what, 'Vinyasa with Sarah');
});
check('the waitlist: offered when places free up, earliest first, only when their places fit, each once', () => {
    const src = read('src/utils/class-sessions.ts');
    assert.ok(src.includes('.orderBy(asc(classWaitlist.createdAt))') && src.includes('if (w.places > left) continue;'));
    assert.ok(src.includes('.set({ offeredAt: new Date() }).where(and(eq(classWaitlist.id, w.id), isNull(classWaitlist.offeredAt)))'));
    assert.ok(read('src/utils/site-booking.ts').includes('if (done.sessionId && cls) await offerFreedPlaces('), 'after a customer cancels');
    assert.ok(read('netlify/functions/sites.ts').includes("if (r.booking.sessionId && r.booking.status !== 'confirmed' && site.slug)"), 'after the owner declines or cancels');
});
check('a class place is never "moved" to a time computed from opening hours', () => {
    const src = read('src/utils/site-booking.ts');
    assert.ok(src.includes("const s = row.kind === 'class' ? null : sectionForKind(b.def, row.kind);"));
    assert.ok(src.includes("if (props.kind === 'class') return classStep(b, found, q, message);"));
});

console.log('\nOn the site');

const sv = (over: Partial<SessionView>): SessionView => ({ id: 1, title: 'Vinyasa', serviceId: 4, resourceName: 'Sarah', startsAt: '', endsAt: '', date: '2026-10-20', dateText: 'Tuesday 20 October', timeText: '6pm–7pm', capacity: 12, taken: 8, left: 4, status: 'scheduled', seriesKey: null, price: '£12', ...over });

check('places left in words', () => {
    assert.deepStrictEqual([0, 1, 4].map(placesText), ['Full', '1 place left', '4 places left']);
});
check('the timetable: grouped by day, Book links, and a waitlist when full', () => {
    const html = timetableHtml([sv({}), sv({ id: 2, title: 'Yin', timeText: '7:30pm–8:30pm', left: 0, resourceName: null }), sv({ id: 3, dateText: 'Saturday 24 October', date: '2026-10-24', timeText: '9am–10am' })], 'bk1');
    assert.strictEqual((html.match(/<h3>/g) || []).length, 2);
    assert.ok(html.includes(`<a class="btn s" href="${sessionLink('bk1', 1).replace(/&/g, '&amp;')}">Book</a>`));
    assert.ok(html.includes('Full · <a href="/_book?s=bk1&amp;sess=2">Join the waitlist</a>'));
    assert.ok(html.includes('6pm–7pm · Vinyasa <span class="mt">with Sarah</span>') && html.includes('<span class="mp">£12</span>'));
});
check('a booking section of kind "class" shows the next dates and a link to all of them', () => {
    const def = normaliseSiteDefinition({ settings: { siteName: 'Willowbrook Yoga' }, pages: [{ title: 'Home', slug: '', sections: [{ id: 'bk1', type: 'booking', props: { kind: 'class', heading: 'Classes', serviceIds: [4], askStaff: true } }] }] }).definition;
    const props = def.pages[0].sections[0].props as BookingProps;
    assert.strictEqual(props.kind, 'class');
    assert.strictEqual(props.askStaff, false);
    assert.strictEqual(props.buttonLabel, 'See all dates');
    const sessions = [sv({}), sv({ id: 9, serviceId: 5, title: 'Pilates' })];
    const ctx = { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, booking: { ready: false, services: [], maxPartySize: 6, sessions } };
    const html = renderSitePage(def, '/', ctx).html;
    assert.ok(html.includes('Vinyasa') && !html.includes('Pilates'), 'only the classes the section offers');
    assert.ok(html.includes('href="/_book?s=bk1">See all dates</a>'));
    const none = renderSitePage(def, '/', { ...ctx, booking: { ...ctx.booking, sessions: [] } }).html;
    assert.ok(none.includes('nothing to book just now'));
    const preview = renderSitePage(def, '/', { ...ctx, preview: true }).html;
    assert.ok(preview.includes('Booking works on your live site') && !preview.includes('>Book</a>'));
});

console.log('\nOwner, chat, data');

check('the Website tab has a timetable to add and cancel dates; the chat can propose them', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('function timetableCard()') && ed.includes("action: 'session_add'") && ed.includes("action: 'session_cancel'"));
    assert.ok(ed.includes("['class', 'Classes and events (dates you set, with places)']"));
    const sites = read('netlify/functions/sites.ts');
    assert.ok(sites.includes("if (action === 'session_add')") && sites.includes("for (const b of r.bookings) await emailCustomer(b, 'cancelled', ctx, owner?.email ?? null);"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('{"type":"class_sessions","summary":"<one sentence>","session":{"serviceId":'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('class_sessions', renderClassSessionsCard)"));
    assert.ok(read('src/components/chat-session.js').includes("container.addEventListener('site:classSessions', onClassSessions)"));
});
check('the SQL widens the kind check safely on a re-run, and keeps places per session', () => {
    const sqlText = read('db/z-classes.sql');
    assert.ok(sqlText.includes("AND pg_get_constraintdef(oid) LIKE '%class%'"));
    assert.ok(sqlText.includes("CHECK (kind IN ('appointment', 'consultation', 'table', 'class'))"));
    assert.ok(sqlText.includes('ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES class_sessions(id) ON DELETE SET NULL'));
    assert.ok(sqlText.includes('CREATE UNIQUE INDEX IF NOT EXISTS class_waitlist_session_email_uq'));
});

console.log(`\n${passed}/${total} passed\n`);
