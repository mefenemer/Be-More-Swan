// src/utils/stays.ts — holiday lets and B&B rooms in the database: loading and saving what the owner
// set up, and booking a stay safely. docs/holiday-lets-plan.md. tests/stays.test.ts.
//
// ⚠️ NO DOUBLE BOOKINGS. A stay is made inside the SAME per-workspace advisory lock as every other
// booking (bookings.ts), and the rooms and the price are worked out AGAIN inside it from the bookings
// and rates as they are at that moment (stay-availability.ts, stay-quote.ts — the same functions that
// drew the calendar and the quote). Two guests choosing the last room: the second is told it has gone.
//
// ⚠️ arrival_details (door codes, Wi-Fi) are NEVER sent to a page. Anything a site renders goes
// through publicStay(), which leaves them out.

import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookings, bookingSettings, bookingUnits, stayBlocks, stayFees, stayRates, stayTypes, stayUnits } from '../../db/schema';
import { addDays, utcToZoned, zonedToUtc, type DayKey } from './booking-time';
import { holdsTime, holdUntil } from './booking-deposits';
import { assignUnits, type StayUnit, type UnitHold } from './stay-availability';
import { quoteStay, type CancellationStep, type StayFee, type StayPricing, type StayQuote, type StayRate } from './stay-quote';
import type { CleanStayFee, CleanStayRate, CleanStayType, StayImage, StayAmenity } from './stay-clean';
import { slugifyStay } from './stay-clean';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type StayTypeRow = typeof stayTypes.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;

export interface LoadedStay {
    row: StayTypeRow;
    rates: StayRate[];
    fees: StayFee[];
    units: StayUnit[];
}

const asDays = (v: unknown): DayKey[] | null => (Array.isArray(v) && v.length ? v as DayKey[] : null);

function rateFromRow(r: typeof stayRates.$inferSelect): StayRate {
    return {
        name: r.name, startsOn: r.startsOn, endsOn: r.endsOn, nightly: r.nightly, weekendNightly: r.weekendNightly,
        weeklyNightly: r.weeklyNightly, minNights: r.minNights, changeoverDays: asDays(r.changeoverDays),
    };
}

function feeFromRow(f: typeof stayFees.$inferSelect): StayFee {
    return { id: f.id, kind: f.kind as StayFee['kind'], label: f.label, amount: f.amount, per: f.per as StayFee['per'], afterGuests: f.afterGuests, optional: f.optional };
}

/** Every stay type of a workspace with its rates, fees and units. `activeOnly` = what a site may offer. */
export async function loadStays(db: Db | Tx, orgId: number, opts: { activeOnly?: boolean; ids?: number[] } = {}): Promise<LoadedStay[]> {
    const where = [eq(stayTypes.organisationId, orgId)];
    if (opts.activeOnly) where.push(eq(stayTypes.status, 'active'));
    if (opts.ids) { if (!opts.ids.length) return []; where.push(inArray(stayTypes.id, opts.ids)); }
    const types = await db.select().from(stayTypes).where(and(...where)).orderBy(asc(stayTypes.sortOrder), asc(stayTypes.id));
    if (!types.length) return [];
    const ids = types.map((t) => t.id);
    const [rates, fees, units] = await Promise.all([
        db.select().from(stayRates).where(and(eq(stayRates.organisationId, orgId), inArray(stayRates.stayTypeId, ids))).orderBy(asc(stayRates.sortOrder), asc(stayRates.id)),
        db.select().from(stayFees).where(and(eq(stayFees.organisationId, orgId), inArray(stayFees.stayTypeId, ids))).orderBy(asc(stayFees.sortOrder), asc(stayFees.id)),
        db.select().from(stayUnits).where(and(eq(stayUnits.organisationId, orgId), inArray(stayUnits.stayTypeId, ids), eq(stayUnits.status, 'active'))).orderBy(asc(stayUnits.sortOrder), asc(stayUnits.id)),
    ]);
    return types.map((row) => ({
        row,
        rates: rates.filter((r) => r.stayTypeId === row.id).map(rateFromRow),
        fees: fees.filter((f) => f.stayTypeId === row.id).map(feeFromRow),
        units: units.filter((u) => u.stayTypeId === row.id).map((u) => ({ id: u.id, name: u.name })),
    }));
}

/** What the quote needs from a loaded stay. */
export function pricingOf(s: LoadedStay): StayPricing {
    const r = s.row;
    return {
        currency: r.currency, maxGuests: r.maxGuests, singleDiscount: r.stayType === 'room' ? r.singleDiscount : null,
        rates: s.rates, fees: s.fees, depositPercent: r.depositPercent, balanceDays: r.balanceDays,
        balanceCollection: r.balanceCollection === 'auto' ? 'auto' : 'link', damageDeposit: r.damageDeposit,
        cancellation: Array.isArray(r.cancellation) ? r.cancellation as CancellationStep[] : [],
    };
}

/** What a site may show about a stay. Built field by field — arrival details are left out on purpose. */
export function publicStay(s: LoadedStay) {
    const r = s.row;
    return {
        id: r.id, stayType: r.stayType as 'whole' | 'room', name: r.name, slug: r.slug, summary: r.summary, description: r.description,
        maxGuests: r.maxGuests, bedrooms: r.bedrooms, bathrooms: r.bathrooms, beds: r.beds,
        amenities: (Array.isArray(r.amenities) ? r.amenities : []) as StayAmenity[],
        houseRules: r.houseRules, address: r.address, licenceNumber: r.licenceNumber,
        images: (Array.isArray(r.images) ? r.images : []) as StayImage[],
        checkInTime: r.checkInTime, checkOutTime: r.checkOutTime, mode: r.mode as 'instant' | 'request', breakfast: r.breakfast,
        units: s.units.length,
        pricing: pricingOf(s),
        limits: { minNoticeDays: r.minNoticeDays, maxAdvanceDays: r.maxAdvanceDays },
        gapNights: r.gapNights,
    };
}
// end publicStay
export type PublicStay = ReturnType<typeof publicStay>;

/** The business's timezone (Business Information ▸ hours), London when never set. */
export async function businessTimezone(db: Db | Tx, orgId: number): Promise<string> {
    const [row] = await db.select({ timezone: bookingSettings.timezone }).from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
    return row?.timezone || 'Europe/London';
}

/**
 * What holds these units between two dates: stays not cancelled / declined / lapsed, and the owner's
 * blocks. Read with a margin for turnover nights.
 */
export async function loadHolds(db: Db | Tx, orgId: number, unitIds: number[], from: string, to: string, margin = 7): Promise<UnitHold[]> {
    if (!unitIds.length) return [];
    const lo = addDays(from, -margin);
    const hi = addDays(to, margin);
    const [booked, blocked] = await Promise.all([
        db.select({ unitId: bookingUnits.unitId, checkIn: bookingUnits.checkIn, checkOut: bookingUnits.checkOut })
            .from(bookingUnits).innerJoin(bookings, eq(bookings.id, bookingUnits.bookingId))
            .where(and(eq(bookingUnits.organisationId, orgId), inArray(bookingUnits.unitId, unitIds), lt(bookingUnits.checkIn, hi), gt(bookingUnits.checkOut, lo), holdsTime)),
        db.select({ unitId: stayBlocks.unitId, checkIn: stayBlocks.startsOn, checkOut: stayBlocks.endsOn })
            .from(stayBlocks)
            .where(and(eq(stayBlocks.organisationId, orgId), inArray(stayBlocks.unitId, unitIds), lt(stayBlocks.startsOn, hi), gt(stayBlocks.endsOn, lo))),
    ]);
    return [...booked, ...blocked];
}

// ── Saving what the owner set up (the Stays tab and the chat card both come here) ─────────────

/** A slug not yet used by another stay of this workspace. */
async function freeSlug(db: Db | Tx, orgId: number, name: string, exceptId: number | null): Promise<string> {
    const base = slugifyStay(name);
    const rows = await db.select({ id: stayTypes.id, slug: stayTypes.slug }).from(stayTypes).where(eq(stayTypes.organisationId, orgId));
    const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 500; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    return `${base}-${Date.now()}`;
}

/** Create (id null) or update a stay type. A whole property always has exactly one unit, named after it. */
export async function saveStayType(db: Db, orgId: number, id: number | null, v: CleanStayType & { cancellation: CancellationStep[] }): Promise<StayTypeRow | null> {
    return db.transaction(async (tx) => {
        const values = { ...v, cancellation: v.cancellation, amenities: v.amenities, images: v.images, updatedAt: new Date() };
        let row: StayTypeRow | undefined;
        if (id === null) {
            const slug = await freeSlug(tx, orgId, v.name, null);
            [row] = await tx.insert(stayTypes).values({ organisationId: orgId, slug, ...values }).returning();
        } else {
            [row] = await tx.update(stayTypes).set(values).where(and(eq(stayTypes.id, id), eq(stayTypes.organisationId, orgId))).returning();
        }
        if (!row) return null;
        const units = await tx.select().from(stayUnits).where(and(eq(stayUnits.stayTypeId, row.id), eq(stayUnits.status, 'active')));
        if (row.stayType === 'whole') {
            if (!units.length) await tx.insert(stayUnits).values({ organisationId: orgId, stayTypeId: row.id, name: row.name });
            else await tx.update(stayUnits).set({ name: row.name }).where(eq(stayUnits.id, units[0].id));
        } else if (!units.length) {
            await tx.insert(stayUnits).values({ organisationId: orgId, stayTypeId: row.id, name: 'Room 1' });
        }
        return row;
    });
}

/** Replace a stay type's rates in full (the editor always sends the whole list). */
export async function replaceStayRates(db: Db, orgId: number, stayTypeId: number, rates: CleanStayRate[]): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [own] = await tx.select({ id: stayTypes.id }).from(stayTypes).where(and(eq(stayTypes.id, stayTypeId), eq(stayTypes.organisationId, orgId))).limit(1);
        if (!own) return false;
        await tx.delete(stayRates).where(eq(stayRates.stayTypeId, stayTypeId));
        if (rates.length) {
            await tx.insert(stayRates).values(rates.map((r, i) => ({ organisationId: orgId, stayTypeId, ...r, sortOrder: i })));
        }
        return true;
    });
}

/** Replace a stay type's fees in full. */
export async function replaceStayFees(db: Db, orgId: number, stayTypeId: number, fees: CleanStayFee[]): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [own] = await tx.select({ id: stayTypes.id }).from(stayTypes).where(and(eq(stayTypes.id, stayTypeId), eq(stayTypes.organisationId, orgId))).limit(1);
        if (!own) return false;
        await tx.delete(stayFees).where(eq(stayFees.stayTypeId, stayTypeId));
        if (fees.length) await tx.insert(stayFees).values(fees.map((f, i) => ({ organisationId: orgId, stayTypeId, ...f, sortOrder: i })));
        return true;
    });
}

/**
 * Set a room type's rooms by name. Rooms still named are kept (their bookings stay with them); a room
 * no longer named is archived, never deleted, and refused while it has stays to come.
 */
export async function setRoomNames(db: Db, orgId: number, stayTypeId: number, names: string[], today: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const clean = [...new Set(names.map((n) => n.trim().slice(0, 60)).filter(Boolean))].slice(0, 100);
    if (!clean.length) return { ok: false, message: 'A room type needs at least one room.' };
    return db.transaction(async (tx) => {
        const [type] = await tx.select().from(stayTypes).where(and(eq(stayTypes.id, stayTypeId), eq(stayTypes.organisationId, orgId))).limit(1);
        if (!type || type.stayType !== 'room') return { ok: false as const, message: 'That room type was not found.' };
        const units = await tx.select().from(stayUnits).where(and(eq(stayUnits.stayTypeId, stayTypeId), eq(stayUnits.status, 'active')));
        const leaving = units.filter((u) => !clean.includes(u.name));
        if (leaving.length) {
            const future = await tx.select({ unitId: bookingUnits.unitId }).from(bookingUnits).innerJoin(bookings, eq(bookings.id, bookingUnits.bookingId))
                .where(and(inArray(bookingUnits.unitId, leaving.map((u) => u.id)), gt(bookingUnits.checkOut, today), holdsTime)).limit(1);
            if (future.length) {
                const name = leaving.find((u) => u.id === future[0].unitId)?.name ?? 'That room';
                return { ok: false as const, message: `${name} has guests booked. Move them to another room first.` };
            }
            await tx.update(stayUnits).set({ status: 'archived' }).where(inArray(stayUnits.id, leaving.map((u) => u.id)));
        }
        const have = new Set(units.map((u) => u.name));
        for (const [i, name] of clean.entries()) {
            if (have.has(name)) await tx.update(stayUnits).set({ sortOrder: i }).where(and(eq(stayUnits.stayTypeId, stayTypeId), eq(stayUnits.name, name), eq(stayUnits.status, 'active')));
            else await tx.insert(stayUnits).values({ organisationId: orgId, stayTypeId, name, sortOrder: i });
        }
        return { ok: true as const };
    });
}

// ── Booking a stay ──────────────────────────────────────────────────────────────────────────

export interface NewStay {
    stayTypeId: number;
    checkIn: string;
    checkOut: string;
    guests: number;
    rooms: number;
    extras: number[];
    siteId: number | null;
    customerName: string;
    customerEmail: string;
    customerPhone: string | null;
    notes: string | null;
    now: Date;
    /** The workspace's Stripe account can take the payment: made as 'awaiting_payment' until paid. */
    takePayment: boolean;
}

export type CreateStayResult =
    | { ok: true; booking: BookingRow; quote: StayQuote; units: StayUnit[] }
    | { ok: false; reason: 'gone' | 'invalid'; message: string };

/** Book a stay: re-check the rules, the rooms and the price under the lock, then hold the rooms. */
export async function createStay(db: Db, orgId: number, s: NewStay): Promise<CreateStayResult> {
    return db.transaction(async (tx) => {
        // The SAME lock as appointments, tables and classes: one booking at a time per workspace.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bookings:${orgId}`}))`);
        const [stay] = await loadStays(tx, orgId, { activeOnly: true, ids: [s.stayTypeId] });
        if (!stay) return { ok: false, reason: 'invalid', message: 'That place is not taking bookings.' } as const;
        const tz = await businessTimezone(tx, orgId);
        const today = utcToZoned(s.now, tz).date;
        const r = stay.row;
        const rooms = r.stayType === 'whole' ? 1 : s.rooms;
        const priced = quoteStay(pricingOf(stay), { checkIn: s.checkIn, checkOut: s.checkOut, guests: s.guests, rooms, extras: s.extras, today },
            { minNoticeDays: r.minNoticeDays, maxAdvanceDays: r.maxAdvanceDays });
        if (!priced.ok) return { ok: false, reason: 'invalid', message: priced.message } as const;
        const holds = await loadHolds(tx, orgId, stay.units.map((u) => u.id), s.checkIn, s.checkOut, r.gapNights + 1);
        const units = assignUnits(stay.units, holds, s.checkIn, s.checkOut, rooms, r.gapNights);
        if (!units) {
            return { ok: false, reason: 'gone', message: rooms > 1 ? `Sorry — there aren't ${rooms} rooms free for all of those nights any more.` : 'Sorry — those dates have just been taken. Please choose others.' } as const;
        }
        const q = priced.quote;
        const awaiting = s.takePayment && q.dueNow > 0;
        const instant = r.mode === 'instant';
        const [row] = await tx.insert(bookings).values({
            organisationId: orgId, siteId: s.siteId, kind: 'stay', stayTypeId: r.id,
            startsAt: zonedToUtc(s.checkIn, r.checkInTime, tz), endsAt: zonedToUtc(s.checkOut, r.checkOutTime, tz),
            checkIn: s.checkIn, checkOut: s.checkOut, partySize: s.guests, rooms,
            customerName: s.customerName, customerEmail: s.customerEmail, customerPhone: s.customerPhone, notes: s.notes,
            serviceName: r.name, resourceName: units.map((u) => u.name).join(', '),
            status: awaiting ? 'awaiting_payment' : instant ? 'confirmed' : 'pending',
            decidedAt: !awaiting && instant ? new Date() : null,
            quote: q, currency: q.currency,
            balancePence: q.balance, balanceStatus: q.balance > 0 ? 'due' : 'none', balanceDueOn: q.balanceDueOn,
            balanceCollection: q.balanceCollection,
            damageDepositPence: q.damageDeposit || null, damageDepositStatus: q.damageDeposit > 0 ? 'due' : 'none',
            // Given back by itself this many days after check-out, unless the owner decides first (stay-jobs.ts).
            damageDepositReturnOn: q.damageDeposit > 0 ? addDays(s.checkOut, r.damageDepositReturnDays) : null,
            ...(awaiting ? { depositPence: q.dueNow, paymentStatus: 'unpaid', holdExpiresAt: holdUntil(s.now) } : {}),
        }).returning();
        await tx.insert(bookingUnits).values(units.map((u) => ({ organisationId: orgId, bookingId: row.id, unitId: u.id, checkIn: s.checkIn, checkOut: s.checkOut })));
        return { ok: true, booking: row, quote: q, units } as const;
    });
}
