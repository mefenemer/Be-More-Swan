// tests/bookings-changes.test.ts
// Bookings phase 2 (docs/booking-plan.md): the customer cancels or moves their own booking from a
// signed link (booking-links.ts, site-booking.ts), a move can never double-book or lose the booking
// (bookings.ts createBooking replaceBookingId), and the day-before reminder (send-booking-reminders.ts).
//
// Run:  npx tsx tests/bookings-changes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { manageBookingUrl, signBookingId, verifyBookingToken } from '../src/utils/booking-links';
import { customerCanChange } from '../src/utils/bookings';
import { bookLink, readChoice } from '../src/utils/site-booking';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-booking-links';

console.log('\nThe manage link');

check('signed per booking: right id + token only; another booking\'s token never works', () => {
    const t = signBookingId(41);
    assert.match(t, /^[0-9a-f]{20}$/);
    assert.ok(verifyBookingToken(41, t));
    assert.ok(!verifyBookingToken(42, t), 'not transferable');
    assert.ok(!verifyBookingToken(41, t.slice(0, 19)), 'a short token fails');
    assert.ok(!verifyBookingToken(41, ''));
    assert.strictEqual(manageBookingUrl('https://willowbrook.bemoreswan.site/', 41), `https://willowbrook.bemoreswan.site/_book?manage=41&t=${t}`);
});

check('the link appears in the request, confirmation and reminder emails — never after a decline or cancel', () => {
    const src = read('src/utils/bookings.ts');
    assert.ok(src.includes("(notice === 'received' || notice === 'confirmed' || notice === 'reminder') ? manageBookingUrl(ctx.siteOrigin, b.id)"));
    assert.ok(src.includes('Change or cancel your booking'));
});

console.log('\nWhen they may change it');

check('pending or confirmed, and later than the notice the business needs', () => {
    const now = new Date('2026-10-15T08:00:00Z');
    const at = (h: number) => new Date(now.getTime() + h * 3600_000);
    assert.ok(customerCanChange({ status: 'confirmed', startsAt: at(5) }, 120, now));
    assert.ok(customerCanChange({ status: 'pending', startsAt: at(5) }, 120, now));
    assert.ok(!customerCanChange({ status: 'confirmed', startsAt: at(1) }, 120, now), 'inside the notice: get in touch instead');
    assert.ok(!customerCanChange({ status: 'cancelled', startsAt: at(48) }, 120, now));
    assert.ok(!customerCanChange({ status: 'declined', startsAt: at(48) }, 120, now));
});

console.log('\nMoving');

check('a move carries its booking through every step, and only with a well-formed token', () => {
    const t = signBookingId(41);
    const c = readChoice(new URLSearchParams(`s=abc&svc=5&res=any&mv=41&mt=${t}`));
    assert.strictEqual(c.mv, 41);
    assert.strictEqual(c.mt, t);
    assert.ok(bookLink(c, { date: '2026-10-16' }).endsWith(`&date=2026-10-16&mv=41&mt=${t}`));
    assert.strictEqual(readChoice(new URLSearchParams('mv=41&mt=<script>')).mt, null);
});

check('a move releases the old time and books the new in ONE locked transaction — undone if the new time has gone', () => {
    const src = read('src/utils/bookings.ts');
    const fn = src.slice(src.indexOf('export async function createBooking'), src.indexOf('// ── The customer\'s own changes'));
    assert.ok(fn.indexOf('pg_advisory_xact_lock(') < fn.indexOf("set({ status: 'cancelled', cancelledBy: 'customer'"), 'released under the lock');
    assert.ok(fn.indexOf("set({ status: 'cancelled', cancelledBy: 'customer'") < fn.indexOf('slotsForDay(tx,'), 'released before the re-check, so the same person can take the next slot');
    assert.ok(fn.includes('if (b.replaceBookingId) throw new UndoMove()'), 'no new slot → the transaction rolls back and the old booking stands');
    assert.ok(fn.includes('movedFromId: b.replaceBookingId ?? null'));
    assert.ok(fn.includes("inArray(bookings.status, ['pending', 'confirmed'])"), 'only a live booking can be moved');
});

check('every manage action verifies the signature and the business before touching anything', () => {
    const src = read('src/utils/site-booking.ts');
    const from = src.slice(src.indexOf('async function bookingFromLink'), src.indexOf('function sectionForKind'));
    assert.ok(from.indexOf('verifyBookingToken(') < from.indexOf('loadBooking('));
    assert.ok(from.includes('row.organisationId === b.site.organisationId'), 'a link from another business\'s booking is refused');
    for (const fnName of ['async function managePage', 'async function cancelSubmit', 'async function moveSubmit']) {
        const body = src.slice(src.indexOf(fnName), src.indexOf(fnName) + 1200);
        assert.ok(body.includes('bookingFromLink('), fnName);
    }
    const cancel = src.slice(src.indexOf('async function cancelSubmit'), src.indexOf('async function moveSubmit'));
    assert.ok(cancel.indexOf('customerCanChange(') < cancel.indexOf('customerCancel('));
    assert.ok(cancel.includes("emailCustomer(done, 'cancelled_by_you'") && cancel.includes("announceCustomerChange(b.db, 'cancelled'"));
    const move = src.slice(src.indexOf('async function moveSubmit'));
    assert.ok(move.includes('replaceBookingId: old.id') && move.includes('customerEmail: old.customerEmail'), 'the booking\'s own details — nothing retyped');
    assert.ok(move.includes("announceCustomerChange(b.db, 'moved', made.booking, ctx, old)"));
    assert.ok(src.includes("<button class=\"btn\" type=\"submit\">Yes, cancel it</button>"), 'cancelling asks first');
});

console.log('\nReminders and the owner');

check('reminder: confirmed, within 24 hours, booked more than a day ahead, claimed before sending, once', () => {
    const fn = read('netlify/functions/send-booking-reminders.ts');
    assert.ok(fn.includes("eq(bookings.status, 'confirmed'), isNull(bookings.reminderSentAt)"));
    assert.ok(fn.includes("sql`${bookings.createdAt} < ${bookings.startsAt} - interval '24 hours'`"));
    assert.ok(fn.indexOf('.set({ reminderSentAt: new Date() })') < fn.indexOf("emailCustomer(b as BookingRow, 'reminder'"), 'claimed first: two runs cannot both send');
    assert.ok(read('netlify.toml').includes('[functions.send-booking-reminders]\n  schedule = "20 * * * *"'));
    assert.ok(read('db/z-bookings-changes.sql').includes('ADD COLUMN IF NOT EXISTS reminder_sent_at'));
});

check('the owner is told about a cancel or move; cancellations record who; the list shows it', () => {
    assert.strictEqual(getNotificationDefault('site_booking_changed')?.type, 'site_booking_changed');
    assert.ok(read('src/utils/notification-actions.ts').includes("site_booking_changed: 'state_change'"));
    assert.ok(read('src/utils/notification-prefs.ts').includes("'site_booking_changed'"));
    assert.ok(read('db/notifications-categorization.sql').includes("WHEN 'site_booking_changed'"));
    assert.ok(read('src/utils/bookings.ts').includes("...(action === 'cancel' ? { cancelledBy: 'owner' } : {})"));
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes("x.cancelledBy === 'customer' ? 'Cancelled by them' : 'Cancelled by you'") && ed.includes('moved by them'));
});

console.log(`\n${passed}/${total} passed`);
