// src/utils/bookings.ts — bookings in the database: what can be booked, making a booking safely,
// the owner's decisions, and the emails. docs/booking-plan.md. tests/bookings.test.ts.
//
// ⚠️ NO DOUBLE BOOKINGS. A booking is made inside a transaction holding a per-workspace advisory lock,
// and availability is computed AGAIN inside it from the bookings as they are at that moment
// (booking-availability.ts — the same function that drew the times). Two people choosing the same
// slot: the second is told it has just gone, and shown the times still free.
//
// Services are Business Information products (org_products) with a duration; their names and
// prices are read from there, never typed here. Opening hours and rules: booking_settings.

import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import type { getDb } from '../../db/client';
import { aiAssistants, bookableResources, bookingSettings, bookings, orgProducts, users } from '../../db/schema';
import { availableSlots, type AvailabilityResource, type BookingKind, type Slot, type TakenBooking } from './booking-availability';
import { settingsFromRow, BOOKING_DEFAULTS, cleanWeeklyHours } from './booking-settings';
import { addDays, formatDate, formatTime, utcToZoned } from './booking-time';
import { createNotification } from './notify';
import { sendEmail } from './email';
import { esc, type SiteRenderBooking, type SiteRenderBusiness } from './site-render';
import { manageBookingUrl } from './booking-links';
import { depositNote, holdsTime, holdUntil, refundDeposit } from './booking-deposits';
import { connectAccountFor } from './site-shop';
import { loadBusy } from './calendar-sync';
import { depositLabel } from './product-price';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface BookableService { id: number; name: string; price: string | null; durationMinutes: number; description: string | null;
    depositType: string | null; depositAmount: number | null; priceType: string | null; priceAmount: number | null; }
export interface BookingSetup {
    exists: boolean;
    settings: typeof BOOKING_DEFAULTS;
    resources: Array<AvailabilityResource & { kind: string }>;
    services: BookableService[];
}

export async function loadBookingSetup(db: Db | Tx, orgId: number): Promise<BookingSetup> {
    const [row] = await db.select().from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
    const res = await db.select().from(bookableResources)
        .where(and(eq(bookableResources.organisationId, orgId), eq(bookableResources.status, 'active')))
        .orderBy(asc(bookableResources.sortOrder), asc(bookableResources.id));
    const svc = await db.select({ id: orgProducts.id, name: orgProducts.name, price: orgProducts.price, durationMinutes: orgProducts.durationMinutes, description: orgProducts.description,
        depositType: orgProducts.depositType, depositAmount: orgProducts.depositAmount, priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount })
        .from(orgProducts)
        .where(and(eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active'), isNotNull(orgProducts.durationMinutes)))
        .orderBy(asc(orgProducts.sortOrder), asc(orgProducts.id));
    return {
        exists: !!row,
        settings: settingsFromRow(row as Record<string, unknown> | undefined),
        resources: res.map((r) => {
            const hours = r.weeklyHours ? cleanWeeklyHours(r.weeklyHours) : null;
            return {
                id: r.id, name: r.name, kind: r.kind, capacity: r.capacity,
                weeklyHours: hours && hours.ok && Object.keys(hours.value).length ? hours.value : null,
                serviceIds: Array.isArray(r.serviceIds) ? (r.serviceIds as unknown[]).map(Number).filter(Number.isInteger) : null,
            };
        }),
        services: svc.filter((s) => (s.durationMinutes ?? 0) > 0).map((s) => ({ ...s, durationMinutes: s.durationMinutes! })),
    };
}

/** Hours and where to find the business, for the site's hours section and search data. Null = never set up. */
export async function businessSummary(db: Db, orgId: number): Promise<SiteRenderBusiness | null> {
    const [row] = await db.select().from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
    if (!row) return null;
    const st = settingsFromRow(row as Record<string, unknown>);
    return { timezone: st.timezone, weeklyHours: st.weeklyHours, closures: st.closures, visitAddress: st.visitAddress, whatsapp: st.whatsapp };
}

/** Which resources a booking kind uses: tables/areas for tables; staff and rooms for appointments. */
export function resourcesForKind(setup: BookingSetup, kind: BookingKind) {
    return setup.resources.filter((r) => (kind === 'table' ? r.kind === 'table' : r.kind !== 'table'));
}

async function takenOn(db: Db | Tx, orgId: number, date: string): Promise<TakenBooking[]> {
    // A generous window around the local day (any timezone): a booking from the evening before can overlap.
    const from = new Date(`${addDays(date, -1)}T00:00:00Z`);
    const to = new Date(`${addDays(date, 2)}T00:00:00Z`);
    const rows = await db.select({ resourceId: bookings.resourceId, startsAt: bookings.startsAt, endsAt: bookings.endsAt, partySize: bookings.partySize })
        .from(bookings)
        .where(and(eq(bookings.organisationId, orgId), holdsTime, gte(bookings.startsAt, from), lt(bookings.startsAt, to)));
    return rows.map((r) => ({ resourceId: r.resourceId, startsAt: new Date(r.startsAt), endsAt: new Date(r.endsAt), partySize: r.partySize }));
}

/** What a booking section's first step needs (site-render.ts SiteRenderBooking). */
export async function bookingSummary(db: Db, orgId: number): Promise<SiteRenderBooking> {
    const setup = await loadBookingSetup(db, orgId);
    // A deposit is mentioned only where it will actually be taken: Stripe connected and able to charge.
    const takes = !!(await connectAccountFor(db, orgId))?.chargesEnabled;
    return {
        ready: Object.keys(setup.settings.weeklyHours).length > 0,
        services: setup.services.map((s) => ({ id: s.id, name: s.name, price: s.price, durationMinutes: s.durationMinutes, deposit: takes ? depositLabel(s) : null })),
        maxPartySize: setup.settings.maxPartySize,
    };
}

export interface SlotRequest { kind: BookingKind; date: string; serviceId: number | null; resourceId: number | null; partySize: number; now: Date; }

export async function slotsForDay(db: Db | Tx, orgId: number, setup: BookingSetup, req: SlotRequest): Promise<Slot[]> {
    const service = req.serviceId ? setup.services.find((s) => s.id === req.serviceId) : null;
    if (req.kind !== 'table' && !service) return [];
    const taken = await takenOn(db, orgId, req.date);
    // Busy in the owner's own calendar (calendar-sync.ts) — appointments only; tables never.
    const busy = req.kind === 'table' ? [] : await loadBusy(db as Db, orgId, new Date(`${addDays(req.date, -1)}T00:00:00Z`), new Date(`${addDays(req.date, 2)}T00:00:00Z`));
    return availableSlots(setup.settings, resourcesForKind(setup, req.kind), taken, {
        date: req.date, kind: req.kind, durationMinutes: service?.durationMinutes ?? 0,
        serviceId: req.serviceId, resourceId: req.resourceId, partySize: req.partySize, now: req.now,
    }, busy);
}

export interface NewBooking extends SlotRequest {
    siteId: number | null;
    time: string;
    customerName: string;
    customerEmail: string;
    customerPhone: string | null;
    notes: string | null;
    /** Pence: made as 'awaiting_payment', holding its time until paid (booking-deposits.ts). */
    deposit?: number | null;
}

export type CreateResult = { ok: true; booking: typeof bookings.$inferSelect } | { ok: false; reason: 'gone' | 'invalid'; message: string };

/** Thrown inside the transaction to undo a half-made move (the old booking stays as it was). */
class UndoMove extends Error {}

/** Make a booking: re-check the time under the lock, then hold it. Never double-books. */
/**
 * `replaceBookingId` — a MOVE: the customer's existing booking is released and the new time booked in
 * the same locked transaction. If the new time has gone meanwhile, the whole thing is undone and the
 * old booking stands, so a move can neither double-book nor leave them with nothing.
 */
export async function createBooking(db: Db, orgId: number, b: NewBooking & { replaceBookingId?: number }): Promise<CreateResult> {
    const gone: CreateResult = { ok: false, reason: 'gone', message: 'Sorry — that time has just been taken. Please choose another.' };
    let moved: BookingRow | null = null;
    try {
        return await db.transaction(async (tx) => {
        // One booking at a time per workspace — the re-check below sees every booking made before ours.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bookings:${orgId}`}))`);
        if (b.replaceBookingId) {
            // Release the old time first, so the new one may be the same person's next slot.
            const [old] = await tx.update(bookings).set({ status: 'cancelled', cancelledBy: 'customer', decidedAt: new Date() })
                .where(and(eq(bookings.id, b.replaceBookingId), eq(bookings.organisationId, orgId), inArray(bookings.status, ['pending', 'confirmed']))).returning();
            moved = old ?? null;
            if (!old) return { ok: false, reason: 'invalid', message: 'That booking can\'t be changed any more.' } as CreateResult;
        }
        const setup = await loadBookingSetup(tx, orgId);
        const slots = await slotsForDay(tx, orgId, setup, b);
        const slot = slots.find((s) => s.time === b.time);
        if (!slot) { if (b.replaceBookingId) throw new UndoMove(); return gone; }
        const resourceId = b.resourceId !== null ? (slot.resourceIds.includes(b.resourceId) ? b.resourceId : undefined) : slot.resourceIds[0];
        if (resourceId === undefined) { if (b.replaceBookingId) throw new UndoMove(); return gone; }
        const service = b.serviceId ? setup.services.find((s) => s.id === b.serviceId) : null;
        const resource = resourceId !== null ? setup.resources.find((r) => r.id === resourceId) : null;
        const awaiting = !b.replaceBookingId && !!b.deposit;
        const instant = setup.settings.mode === 'instant';
        const [row] = await tx.insert(bookings).values({
            organisationId: orgId, siteId: b.siteId, serviceId: service?.id ?? null, resourceId: resourceId ?? null, kind: b.kind,
            startsAt: slot.startsAt, endsAt: slot.endsAt, partySize: b.kind === 'table' ? b.partySize : 1,
            customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: b.customerPhone, notes: b.notes,
            serviceName: service?.name ?? null, resourceName: resource?.name ?? null,
            status: awaiting ? 'awaiting_payment' : instant ? 'confirmed' : 'pending',
            decidedAt: !awaiting && instant ? new Date() : null,
            movedFromId: b.replaceBookingId ?? null,
            // A deposit: held until paid. A MOVE keeps the deposit already paid on the booking it replaces.
            ...(awaiting ? { depositPence: b.deposit, paymentStatus: 'unpaid', holdExpiresAt: holdUntil(b.now) } : {}),
            ...(moved?.depositPence ? { depositPence: moved.depositPence, paymentStatus: moved.paymentStatus, paymentIntentId: moved.paymentIntentId } : {}),
        }).returning();
        return { ok: true, booking: row } as CreateResult;
        });
    } catch (err) {
        if (err instanceof UndoMove) return gone;
        throw err;
    }
}

// ── The customer's own changes (phase 2) ──────────────────────────────────────────────────────

/**
 * Whether the customer may still cancel or move it themselves: it is pending or confirmed and starts
 * later than the notice the business needs. After that they are asked to get in touch instead.
 */
export function customerCanChange(b: Pick<BookingRow, 'status' | 'startsAt'>, minNoticeMinutes: number, now: Date): boolean {
    return (b.status === 'pending' || b.status === 'confirmed') && new Date(b.startsAt).getTime() > now.getTime() + minNoticeMinutes * 60000;
}

export async function loadBooking(db: Db, id: number): Promise<BookingRow | null> {
    const [row] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    return row ?? null;
}

export async function customerCancel(db: Db, orgId: number, id: number): Promise<BookingRow | null> {
    const [row] = await db.update(bookings).set({ status: 'cancelled', cancelledBy: 'customer', decidedAt: new Date() })
        .where(and(eq(bookings.id, id), eq(bookings.organisationId, orgId), inArray(bookings.status, ['pending', 'confirmed']))).returning();
    return row ?? null;
}

/** The owner hears about a customer's cancel or move: a card, and an email with the details. */
export async function announceCustomerChange(db: Db, change: 'cancelled' | 'moved', b: BookingRow, ctx: BookingNoticeContext, before?: BookingRow): Promise<void> {
    await calendarSoon(db, b.organisationId);
    const { when, what } = describeBooking(b, ctx.timezone);
    const was = before ? describeBooking(before, ctx.timezone).when : null;
    const owner = await ownerOf(db, ctx.assistantId);
    if (!owner) return;
    const next = change === 'cancelled'
        ? 'The time is free again.'
        : b.status === 'pending' ? 'Confirm or decline the new time on the Website tab, under Bookings.' : 'The new time is confirmed — the old one is free again.';
    await createNotification(db, 'site_booking_changed', {
        userId: owner.userId, assistantId: ctx.assistantId ?? undefined, category: change === 'moved' && b.status === 'pending' ? 'suggested_action' : 'state_change',
        context: { assistant: { name: owner.name }, booking: { who: b.customerName, what, when, change: change === 'cancelled' ? `cancelled their booking for ${when}` : `moved their booking${was ? ` from ${was}` : ''} to ${when}`, next } },
        metadata: { assistantId: ctx.assistantId, bookingId: b.id },
    }).catch((err) => console.error('[bookings] change notification failed', err));
    if (owner.email) {
        await sendEmail({
            to: owner.email, replyTo: b.customerEmail,
            subject: change === 'cancelled' ? `Booking cancelled: ${what}, ${when}` : `Booking moved: ${what}, now ${when}`,
            html: `<p><strong>${esc(b.customerName)}</strong> ${change === 'cancelled' ? `cancelled their booking for <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong>` : `moved their booking for <strong>${esc(what)}</strong>${was ? ` from ${esc(was)}` : ''} to <strong>${esc(when)}</strong>`}.</p><p>${esc(next)}</p>`,
        }).catch((err: unknown) => console.error('[bookings] change email failed', err instanceof Error ? err.message : err));
    }
}

// ── What the booking looks like, in words and as a calendar entry ────────────────────────────

export type BookingRow = typeof bookings.$inferSelect;

export function describeBooking(b: BookingRow, tz: string): { when: string; what: string } {
    const z = utcToZoned(new Date(b.startsAt), tz);
    const end = utcToZoned(new Date(b.endsAt), tz);
    const what = b.kind === 'table'
        ? `Table for ${b.partySize}${b.resourceName ? ` (${b.resourceName})` : ''}`
        : `${b.serviceName ?? 'Appointment'}${b.resourceName ? ` with ${b.resourceName}` : ''}${b.kind === 'class' && b.partySize > 1 ? ` (${b.partySize} places)` : ''}`;
    return { when: `${formatDate(z.date)}, ${formatTime(z.time)}–${formatTime(end.time)}`, what };
}

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A calendar invite (RFC 5545) the customer's calendar can add in one tap. */
export function bookingIcs(b: BookingRow, business: string, uidDomain = 'bemoreswan.site'): string {
    const { what } = describeBooking(b, 'UTC');
    return [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Be More Swan//Bookings//EN', 'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:booking-${b.id}@${uidDomain}`,
        `DTSTAMP:${icsTime(new Date())}`,
        `DTSTART:${icsTime(new Date(b.startsAt))}`,
        `DTEND:${icsTime(new Date(b.endsAt))}`,
        `SUMMARY:${icsText(`${what} — ${business}`)}`,
        `DESCRIPTION:${icsText(`Booked with ${business}.`)}`,
        'STATUS:CONFIRMED',
        'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
}

/** "Willowbrook Coffee (via Be More Swan)" — the business named, the address ours (email.ts). */
export const fromLine = (business: string) => `${business.replace(/[<>"\\\r\n]/g, '').slice(0, 60) || 'Your booking'} (via Be More Swan) <noreply@bemoreswan.com>`;

export async function ownerOf(db: Db, assistantId: number | null): Promise<{ userId: number; name: string; email: string | null } | null> {
    if (!assistantId) return null;
    const [o] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name, email: users.email })
        .from(aiAssistants).leftJoin(users, eq(users.id, aiAssistants.userId)).where(eq(aiAssistants.id, assistantId)).limit(1);
    return o ? { userId: o.userId, name: o.name, email: o.email ?? null } : null;
}

export interface BookingNoticeContext {
    business: string; timezone: string; assistantId: number | null; cancellationPolicy: string | null;
    /** https://<slug>.bemoreswan.site — where the customer's manage link points. Null: no link. */
    siteOrigin: string | null;
}

/** After a booking is made: the owner is told (card + email); the customer gets a receipt. */
/** Their signed-in Outlook calendar, brought up to date now (calendar-microsoft.ts). Never throws. */
async function calendarSoon(db: Db, orgId: number): Promise<void> {
    try { await (await import('./calendar-microsoft')).reconcileSoon(db, orgId); } catch { /* the 15-minute sync catches up */ }
}

export async function announceNewBooking(db: Db, b: BookingRow, ctx: BookingNoticeContext): Promise<void> {
    await calendarSoon(db, b.organisationId);
    const { when, what } = describeBooking(b, ctx.timezone);
    const owner = await ownerOf(db, ctx.assistantId);
    const pending = b.status === 'pending';
    if (owner) {
        await createNotification(db, 'site_booking_received', {
            userId: owner.userId, assistantId: ctx.assistantId ?? undefined, category: pending ? 'suggested_action' : 'state_change',
            context: { assistant: { name: owner.name }, booking: { who: b.customerName, what, when, next: pending ? 'Confirm or decline it on the Website tab, under Bookings.' : 'It is confirmed — it is on the Website tab, under Bookings.' } },
            metadata: { assistantId: ctx.assistantId, bookingId: b.id },
        }).catch((err) => console.error('[bookings] notification failed', err));
        if (owner.email) {
            await sendEmail({
                to: owner.email, replyTo: b.customerEmail,
                subject: `${pending ? 'Booking request' : 'New booking'}: ${what}, ${when}`,
                html: `<p><strong>${esc(b.customerName)}</strong> ${pending ? 'asked to book' : 'booked'} <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong>.</p>
<p>Email: ${esc(b.customerEmail)}${b.customerPhone ? `<br>Phone: ${esc(b.customerPhone)}` : ''}</p>
${b.notes ? `<p style="white-space:pre-wrap">${esc(b.notes)}</p>` : ''}
<p>${pending ? 'Confirm or decline it on your Website Assistant\'s Website tab, under Bookings — the time is held until you do.' : 'It is confirmed and on your Website tab, under Bookings.'} Reply to this email to write to them.</p>`,
            }).catch((err: unknown) => console.error('[bookings] owner email failed', err instanceof Error ? err.message : err));
        }
    }
    await emailCustomer(b, pending ? 'received' : 'confirmed', ctx, owner?.email ?? null);
}

export type CustomerNotice = 'received' | 'confirmed' | 'declined' | 'cancelled' | 'cancelled_by_you' | 'reminder';

export async function emailCustomer(b: BookingRow, notice: CustomerNotice, ctx: BookingNoticeContext, ownerEmail: string | null): Promise<void> {
    const { when, what } = describeBooking(b, ctx.timezone);
    const lines: Record<CustomerNotice, { subject: string; body: string }> = {
        received: { subject: `We've got your booking request — ${ctx.business}`, body: `<p>Thanks, ${esc(b.customerName)}. ${esc(ctx.business)} has your request for <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong>.</p><p>It isn't confirmed yet — you'll get another email when it is.</p>` },
        confirmed: { subject: `Booking confirmed — ${ctx.business}, ${when}`, body: `<p>Thanks, ${esc(b.customerName)}. Your booking is confirmed: <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong>.</p><p>The attached invite adds it to your calendar.</p>` },
        declined: { subject: `About your booking request — ${ctx.business}`, body: `<p>Sorry, ${esc(b.customerName)} — ${esc(ctx.business)} can't take your booking for <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong>. Please choose another time on their website.</p>` },
        cancelled: { subject: `Your booking has been cancelled — ${ctx.business}`, body: `<p>${esc(b.customerName)}, your booking for <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong> has been cancelled by ${esc(ctx.business)}.</p>` },
        cancelled_by_you: { subject: `You've cancelled your booking — ${ctx.business}`, body: `<p>${esc(b.customerName)}, your booking for <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong> is cancelled. Thanks for letting ${esc(ctx.business)} know.</p>` },
        reminder: { subject: `See you tomorrow — ${ctx.business}, ${when}`, body: `<p>Hi ${esc(b.customerName)}, a reminder of your booking for <strong>${esc(what)}</strong> on <strong>${esc(when)}</strong>.</p>` },
    };
    // The way to cancel or move it themselves, while that is still possible (site-booking.ts manage page).
    const link = ctx.siteOrigin && (notice === 'received' || notice === 'confirmed' || notice === 'reminder') ? manageBookingUrl(ctx.siteOrigin, b.id) : null;
    const manage = link ? `<p><a href="${esc(link)}">Change or cancel your booking</a></p>` : '';
    const { subject, body } = lines[notice];
    const policy = (notice === 'confirmed' || notice === 'received') && ctx.cancellationPolicy ? `<p><strong>Cancellation:</strong> ${esc(ctx.cancellationPolicy)}</p>` : '';
    // The deposit, where there is one: paid with the booking, or given back when it ended.
    const money = depositNote(b);
    const depositLine = !money ? ''
        : b.paymentStatus === 'refunded' ? `<p>Your ${esc(money.replace(' refunded', ''))} has been refunded — it usually reaches your card within 5–10 days.</p>`
        : b.paymentStatus === 'paid' && (notice === 'received' || notice === 'confirmed' || notice === 'reminder') ? `<p>${esc(money)} — thank you.</p>`
        : b.paymentStatus === 'refund_failed' ? `<p>${esc(ctx.business)} will refund your deposit.</p>` : '';
    await sendEmail({
        to: b.customerEmail, from: fromLine(ctx.business), ...(ownerEmail ? { replyTo: ownerEmail } : {}),
        subject, html: `${body}${depositLine}${policy}${manage}<p>${manage ? 'Or reply to this email.' : 'To change anything, reply to this email.'}</p>`,
        ...(notice === 'confirmed' ? { attachments: [{ filename: 'booking.ics', content: Buffer.from(bookingIcs(b, ctx.business)).toString('base64'), contentType: 'text/calendar' }] } : {}),
    }).catch((err: unknown) => console.error('[bookings] customer email failed', err instanceof Error ? err.message : err));
}

/** The owner confirms, declines or cancels. Only from a state where that makes sense. */
export async function decideBooking(db: Db, orgId: number, id: number, action: 'confirm' | 'decline' | 'cancel', ctx: BookingNoticeContext): Promise<{ ok: true; booking: BookingRow } | { ok: false; error: string }> {
    const from: Record<typeof action, string[]> = { confirm: ['pending'], decline: ['pending'], cancel: ['pending', 'confirmed'] };
    const to = { confirm: 'confirmed', decline: 'declined', cancel: 'cancelled' }[action];
    const [row] = await db.update(bookings).set({ status: to, decidedAt: new Date(), ...(action === 'cancel' ? { cancelledBy: 'owner' } : {}) })
        .where(and(eq(bookings.id, id), eq(bookings.organisationId, orgId), inArray(bookings.status, from[action]))).returning();
    if (!row) return { ok: false, error: 'That booking has already been dealt with.' };
    // Declined or cancelled by the business: a deposit always goes back, before they're told.
    if (action !== 'confirm' && row.paymentStatus === 'paid') row.paymentStatus = await refundDeposit(db, row) === 'refunded' ? 'refunded' : 'refund_failed';
    const [owner] = ctx.assistantId ? await db.select({ email: users.email }).from(aiAssistants).leftJoin(users, eq(users.id, aiAssistants.userId)).where(eq(aiAssistants.id, ctx.assistantId)).limit(1) : [];
    await emailCustomer(row, ({ confirm: 'confirmed', decline: 'declined', cancel: 'cancelled' } as const)[action], ctx, owner?.email ?? null);
    await calendarSoon(db, orgId);
    return { ok: true, booking: row };
}

/** Upcoming and recent bookings for the owner (newest decisions needed first, then by time). */
export async function listBookings(db: Db, orgId: number, sinceDaysAgo = 30): Promise<BookingRow[]> {
    const since = new Date(Date.now() - sinceDaysAgo * 86_400_000);
    return db.select().from(bookings).where(and(eq(bookings.organisationId, orgId), gte(bookings.startsAt, since))).orderBy(asc(bookings.startsAt));
}

/** The customer's email address, hashed — for a per-person rate limit without storing it twice. */
export const emailKey = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
