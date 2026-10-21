// tests/calendar-microsoft.test.ts
// The Outlook / Microsoft 365 calendar, signed in (calendar-microsoft.ts): busy times read in Outlook's
// own terms, bookings and class dates written out by a reconciler that only changes what differs,
// and the sign-in reusing the Outlook email app with its own grant.
//
// Run:  npx tsx tests/calendar-microsoft.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { busyFromGraph, eventForBooking, eventForSession, graphTime, planReconcile, wantedHash } from '../src/utils/calendar-microsoft';
import { envVarPrefix, OUTLOOK_CALENDAR_SCOPE, OUTLOOK_SCOPE } from '../src/utils/workspace-integrations';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nSigning in');

check('a separate grant on the same Azure app: calendar scope, Outlook\'s client id and secret', () => {
    assert.ok(OUTLOOK_CALENDAR_SCOPE.includes('offline_access') && OUTLOOK_CALENDAR_SCOPE.includes('Calendars.ReadWrite') && !OUTLOOK_CALENDAR_SCOPE.includes('Mail.Send'));
    assert.ok(!OUTLOOK_SCOPE.includes('Calendars'), 'the email grant is not widened');
    assert.strictEqual(envVarPrefix('outlook_calendar'), 'OUTLOOK');
    assert.strictEqual(envVarPrefix('gmail'), 'GMAIL');
    const oauth = read('netlify/functions/oauth-integrations.ts');
    assert.ok(oauth.includes("bookings: '/workspace.html?view=assets&tab=bookings'"), 'back to Business Information ▸ Bookings');
    assert.ok(oauth.includes("${standalone.includes('?') ? '&' : '?'}connected="));
    assert.ok(oauth.includes("if (provider === 'outlook_calendar') await forgetMicrosoft(db, ctx.organisationId);"));
    assert.ok(read('src/utils/workspace-integrations.ts').includes("scope: provider === 'outlook_calendar' ? OUTLOOK_CALENDAR_SCOPE : OUTLOOK_SCOPE,"), 'refresh re-sends the right scope');
});

console.log('\nBusy times in');

check('busy, tentative and away count; free, working elsewhere, cancelled and our own events don\'t', () => {
    const ev = (showAs: string, extra: Record<string, unknown> = {}) => ({ start: { dateTime: '2026-10-20T09:00:00.0000000' }, end: { dateTime: '2026-10-20T10:00:00.0000000' }, showAs, ...extra });
    const busy = busyFromGraph([ev('busy'), ev('tentative'), ev('oof'), ev('free'), ev('workingElsewhere'), ev('busy', { isCancelled: true }), ev('busy', { transactionId: 'bms-9-b:12' })]);
    assert.strictEqual(busy.length, 3);
    assert.strictEqual(busy[0].start.toISOString(), '2026-10-20T09:00:00.000Z', 'Graph\'s UTC times read as UTC');
});
check('Graph time strings', () => {
    assert.strictEqual(graphTime('2026-10-20T09:00:00.0000000').toISOString(), '2026-10-20T09:00:00.000Z');
    assert.strictEqual(graphTime('2026-10-20T09:00:00Z').toISOString(), '2026-10-20T09:00:00.000Z');
});

console.log('\nBookings out');

const booking = { id: 12, status: 'pending', startsAt: new Date('2026-10-20T09:00:00Z'), endsAt: new Date('2026-10-20T10:00:00Z'), customerName: 'Sam P', customerEmail: 'sam@example.com', customerPhone: null, notes: 'Fringe', partySize: 1, kind: 'appointment', depositPence: 1000, paymentStatus: 'paid' };

check('a booking: who, how to reach them, the deposit; pending shown tentative', () => {
    const w = eventForBooking(booking, 'Cut & finish with Elena');
    assert.strictEqual(w.key, 'b:12');
    assert.strictEqual(w.subject, 'Cut & finish with Elena — Sam P (to confirm)');
    assert.ok(w.tentative && w.body.includes('sam@example.com') && w.body.includes('£10 deposit paid') && w.body.includes('Notes: Fringe'));
    assert.strictEqual(eventForBooking({ ...booking, status: 'confirmed' }, 'Cut').tentative, false);
});
check('a class date once, with who\'s booked', () => {
    const w = eventForSession({ id: 7, title: 'Vinyasa', resourceName: 'Sarah', startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000), capacity: 12 }, [{ name: 'Ana', places: 1 }, { name: 'Tom', places: 2 }]);
    assert.strictEqual(w.key, 's:7');
    assert.strictEqual(w.subject, 'Vinyasa with Sarah — 3/12 booked');
    assert.ok(w.body.includes('Booked: Ana, Tom ×2'));
});
check('the reconciler changes only what differs; past events are left alone', () => {
    const now = new Date('2026-10-19T00:00:00Z');
    const a = eventForBooking({ ...booking, status: 'confirmed' }, 'Cut');
    const b = eventForBooking({ ...booking, id: 13, status: 'confirmed' }, 'Colour');
    const have = [
        { itemKey: 'b:12', externalId: 'E12', contentHash: wantedHash(a), endsAt: a.end },                 // unchanged
        { itemKey: 'b:13', externalId: 'E13', contentHash: 'stale', endsAt: b.end },                         // changed
        { itemKey: 'b:14', externalId: 'E14', contentHash: 'x', endsAt: new Date('2026-10-25T10:00:00Z') },  // cancelled since
        { itemKey: 'b:2', externalId: 'E2', contentHash: 'x', endsAt: new Date('2026-10-01T10:00:00Z') },    // in the past
    ];
    const c = eventForBooking({ ...booking, id: 15, status: 'confirmed' }, 'Trim');
    const plan = planReconcile([a, b, c], have, now);
    assert.deepStrictEqual(plan.create.map((x) => x.key), ['b:15']);
    assert.deepStrictEqual(plan.update.map((x) => x.key), ['b:13']);
    assert.deepStrictEqual(plan.remove.map((x) => x.externalId), ['E14']);
    assert.deepStrictEqual(plan.forget.map((x) => x.externalId), ['E2']);
});
check('our events carry a transactionId (never read back as busy, never duplicated)', () => {
    const src = read('src/utils/calendar-microsoft.ts');
    assert.ok(src.includes("transactionId: `bms-${orgId}-${w.key}`"));
    assert.ok(src.includes("!String(e.transactionId || '').startsWith('bms-')"));
});

console.log('\nWiring');

check('within moments of a change, every 15 minutes, and never failing a booking', () => {
    const bk = read('src/utils/bookings.ts');
    assert.ok(bk.includes("try { await (await import('./calendar-microsoft')).reconcileSoon(db, orgId); } catch"));
    assert.ok((bk.match(/await calendarSoon\(db, /g) || []).length >= 3, 'new, changed and decided bookings');
    assert.ok(read('netlify/functions/sites.ts').includes('await reconcileSoon(db, orgId);'), 'class dates added or cancelled');
    assert.ok(read('netlify/functions/sync-busy-calendars.ts').includes('await syncMicrosoft(db, orgId, new Date());'));
    assert.ok(read('src/utils/calendar-microsoft.ts').includes("Promise.race([reconcileOut(db, orgId, accessToken, new Date()), new Promise((r) => setTimeout(r, 6000))])"));
});
check('signed in replaces the business\'s iCal address; the card offers it where configured', () => {
    assert.ok(read('src/utils/calendar-microsoft.ts').includes("if (row?.host && row.source !== 'microsoft') await setBusyCalendar(db, orgId, { resourceId: null }, null);"));
    assert.ok(read('netlify/functions/booking-settings.ts').includes('microsoft: { available: !!process.env.OUTLOOK_CLIENT_ID'));
    const ui = read('assets.html');
    assert.ok(ui.includes('href="/api/oauth/outlook_calendar/connect?returnTo=bookings"') && ui.includes('id="cal-ms-disconnect"'));
    assert.ok(read('workspace.html').includes("if (viewParam === 'assets' && tabParam && /^[a-z]{2,20}$/.test(tabParam)) window._bizinfoInitialTab = tabParam;"));
    assert.ok(read('db/z-calendar-microsoft.sql').includes('CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_org_item_uq'));
});

console.log(`\n${passed}/${total} passed\n`);
