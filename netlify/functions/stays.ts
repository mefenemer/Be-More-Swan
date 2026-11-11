// netlify/functions/stays.ts
// Business Information ▸ Stays — the owner's holiday lets and B&B room types (docs/holiday-lets-plan.md).
// Tenant-scoped on every statement. The site reads the same records through stays.ts publicStay().
//
//   GET                                   → { stays, amenities, takesCards }
//   POST   { ...stay, rates, fees, rooms } → { stay }      add one (the whole editor, saved at once)
//   PUT    { id, ...stay, rates, fees, rooms } → { stay }  save the whole editor
//   PUT    { id, partial: true, ...some } → { stay }      change only the fields given (the chat's stay_setup
//                                                           card) — laid over what is saved, then the same checks
//   PATCH  { id, status }                 → { stay }      archive / restore
//   DELETE ?id=N                          → { ok }        remove for good — refused while guests are booked
//   POST   { block: { unitId, startsOn, endsOn, note } } → { block }   close dates (own use, repairs)
//   DELETE ?block=N                       → { ok }
//
// Money arrives in MAJOR units as typed ("95", "95.50") and is stored in minor units (stay-clean.ts).
// Rates and fees are replaced in full on every save; rooms are matched by name (setRoomNames), so a
// room keeps its bookings when the list is edited.

import { and, asc, eq, gt, gte, inArray, lt } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { bookings, bookingUnits, stayBlocks, stayTypes, stayUnits } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { cleanCancellation, cleanStayFee, cleanStayRate, cleanStayType, STAY_AMENITIES, type CleanStayFee, type CleanStayRate } from '../../src/utils/stay-clean';
import { businessTimezone, loadStays, replaceStayFees, replaceStayRates, saveStayType, setRoomNames } from '../../src/utils/stays';
import { holdsTime } from '../../src/utils/booking-deposits';
import { connectAccountFor } from '../../src/utils/site-shop';
import { DATE_RE, utcToZoned } from '../../src/utils/booking-time';
import { fromPrice } from '../../src/utils/stay-quote';
import { siteAssetUrl } from '../../src/utils/site-hosting';
import { resolveBaseUrl } from '../../src/utils/base-url';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const MAX_STAYS = 60;
const MAX_RATES = 30;
const MAX_FEES = 12;
type Db = ReturnType<typeof getDb>;

/** Everything the editor shows for one workspace — the owner's own view, arrival details included. */
async function ownerView(db: Db, orgId: number, today: string, base = 'https://bemoreswan.com') {
    const all = await loadStays(db, orgId);
    const unitIds = all.flatMap((s) => s.units.map((u) => u.id));
    const blocks = unitIds.length
        ? await db.select().from(stayBlocks).where(and(eq(stayBlocks.organisationId, orgId), inArray(stayBlocks.unitId, unitIds), gt(stayBlocks.endsOn, today))).orderBy(asc(stayBlocks.startsOn))
        : [];
    return all.map((s) => ({
        ...s.row,
        // Thumbnails for the editor: the same signed, permanent picture links the site uses.
        images: (Array.isArray(s.row.images) ? s.row.images as Array<{ assetId: number; alt: string }> : []).map((im) => ({ ...im, url: siteAssetUrl(base, im.assetId) })),
        rates: s.rates, fees: s.fees, units: s.units,
        fromPrice: fromPrice({ rates: s.rates, currency: s.row.currency }),
        blocks: blocks.filter((b) => s.units.some((u) => u.id === b.unitId)).map((b) => ({ id: b.id, unitId: b.unitId, startsOn: b.startsOn, endsOn: b.endsOn, note: b.note })),
    }));
}

/** A saved stay as the editor would send it (money back in major units) — what a partial change is laid over. */
export function inputFromView(v: Awaited<ReturnType<typeof ownerView>>[number]): Record<string, unknown> {
    const major = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n / 100));
    return {
        stayType: v.stayType, name: v.name, summary: v.summary, description: v.description, maxGuests: v.maxGuests, bedrooms: v.bedrooms, bathrooms: v.bathrooms,
        beds: v.beds, address: v.address, licenceNumber: v.licenceNumber, checkInTime: v.checkInTime, checkOutTime: v.checkOutTime, breakfast: v.breakfast, mode: v.mode,
        amenities: v.amenities, images: v.images.map((im) => ({ assetId: im.assetId, alt: im.alt })), currency: v.currency, singleDiscount: major(v.singleDiscount),
        rates: v.rates.map((r) => ({ ...r, nightly: major(r.nightly), weekendNightly: major(r.weekendNightly), weeklyNightly: major(r.weeklyNightly) })),
        fees: v.fees.map((f) => ({ kind: f.kind, label: f.label, amount: major(f.amount), per: f.per, afterGuests: f.afterGuests, optional: f.optional })),
        depositPercent: v.depositPercent, balanceDays: v.balanceDays, balanceCollection: v.balanceCollection, damageDeposit: major(v.damageDeposit),
        damageDepositReturnDays: v.damageDepositReturnDays, cancellation: v.cancellation, minNoticeDays: v.minNoticeDays, maxAdvanceDays: v.maxAdvanceDays,
        gapNights: v.gapNights, houseRules: v.houseRules, arrivalDetails: v.arrivalDetails, arrivalDetailsDays: v.arrivalDetailsDays,
        ...(v.stayType === 'room' ? { rooms: v.units.map((u) => u.name) } : {}),
    };
}

type Checked = { ok: true; rates: CleanStayRate[]; fees: CleanStayFee[]; rooms: string[] | null } | { ok: false; error: string };

/** The rates, fees and room names of an editor save, each through the same checks the chat uses. */
function checkParts(body: Record<string, unknown>, stayType: 'whole' | 'room'): Checked {
    const rates: CleanStayRate[] = [];
    const rawRates = Array.isArray(body.rates) ? body.rates.slice(0, MAX_RATES) : [];
    for (const [i, r] of rawRates.entries()) {
        const c = cleanStayRate((r ?? {}) as Record<string, unknown>);
        if (!c.ok) return { ok: false, error: `Price ${i + 1}: ${c.message}` };
        rates.push(c.value);
    }
    if (rates.filter((r) => !r.startsOn).length > 1) return { ok: false, error: 'Only one standard price (without dates) — give the others a first and last night.' };
    const fees: CleanStayFee[] = [];
    for (const [i, f] of (Array.isArray(body.fees) ? body.fees.slice(0, MAX_FEES) : []).entries()) {
        const c = cleanStayFee((f ?? {}) as Record<string, unknown>);
        if (!c.ok) return { ok: false, error: `Extra charge ${i + 1}: ${c.message}` };
        fees.push(c.value);
    }
    const rooms = stayType === 'room' && Array.isArray(body.rooms) ? (body.rooms as unknown[]).map((n) => String(n ?? '')).filter((n) => n.trim()) : null;
    if (stayType === 'room' && rooms && !rooms.length) return { ok: false, error: 'A room type needs at least one room — for example "Room 1".' };
    return { ok: true, rates, fees, rooms };
}

/** Stays that still have guests to come — they may not be deleted, and a type may not switch shape. */
async function hasGuestsToCome(db: Db, orgId: number, stayTypeId: number, today: string): Promise<boolean> {
    const rows = await db.select({ id: bookings.id }).from(bookings)
        .where(and(eq(bookings.organisationId, orgId), eq(bookings.stayTypeId, stayTypeId), gte(bookings.checkOut, today), holdsTime)).limit(1);
    return rows.length > 0;
}

export default withLambda(async (event) => {
    const method = event.httpMethod || '';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    if (method !== 'GET' && ctx.role === 'viewer') return json(403, { error: 'Only people who can edit this workspace can change its stays.' });

    try {
        const today = utcToZoned(new Date(), await businessTimezone(db, orgId)).date;
        const base = resolveBaseUrl((event.headers || {}) as Record<string, string | undefined>) || 'https://bemoreswan.com';
        if (method === 'GET') {
            const account = await connectAccountFor(db, orgId).catch(() => null);
            return json(200, {
                stays: await ownerView(db, orgId, today, base),
                amenities: Object.entries(STAY_AMENITIES).map(([key, label]) => ({ key, label })),
                takesCards: !!account?.chargesEnabled,
            });
        }

        const q = event.queryStringParameters || {};
        if (method === 'DELETE' && q.block) {
            const id = Number(q.block);
            if (!Number.isInteger(id)) return json(400, { error: 'Which closed dates?' });
            await db.delete(stayBlocks).where(and(eq(stayBlocks.id, id), eq(stayBlocks.organisationId, orgId)));
            return json(200, { ok: true });
        }
        if (method === 'DELETE') {
            const id = Number(q.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
            if (await hasGuestsToCome(db, orgId, id, today)) return json(409, { error: 'Guests are booked here. Archive it instead — that stops new bookings and keeps theirs.' });
            const [gone] = await db.delete(stayTypes).where(and(eq(stayTypes.id, id), eq(stayTypes.organisationId, orgId))).returning({ id: stayTypes.id });
            return gone ? json(200, { ok: true }) : json(404, { error: 'Not found.' });
        }

        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid body.' });

        if (method === 'POST' && body.block && typeof body.block === 'object') {
            const b = body.block as Record<string, unknown>;
            const unitId = Number(b.unitId);
            const startsOn = String(b.startsOn ?? '');
            const endsOn = String(b.endsOn ?? '');
            if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn)) return json(400, { error: 'Choose the first night closed and the day it opens again.' });
            if (endsOn <= startsOn) return json(400, { error: 'It opens again after the first closed night — check the dates.' });
            const [unit] = Number.isInteger(unitId) ? await db.select({ id: stayUnits.id }).from(stayUnits).where(and(eq(stayUnits.id, unitId), eq(stayUnits.organisationId, orgId))).limit(1) : [];
            if (!unit) return json(404, { error: 'That room or property was not found.' });
            // Booked nights can't be closed underneath a guest.
            const clash = await db.select({ id: bookingUnits.id }).from(bookingUnits).innerJoin(bookings, eq(bookings.id, bookingUnits.bookingId))
                .where(and(eq(bookingUnits.unitId, unitId), lt(bookingUnits.checkIn, endsOn), gt(bookingUnits.checkOut, startsOn), holdsTime)).limit(1);
            if (clash.length) return json(409, { error: 'Guests are booked on some of those nights. Close the dates around their stay instead.' });
            const [block] = await db.insert(stayBlocks).values({ organisationId: orgId, unitId, startsOn, endsOn, note: String(b.note ?? '').trim().slice(0, 120) || null }).returning();
            return json(201, { block: { id: block.id, unitId: block.unitId, startsOn: block.startsOn, endsOn: block.endsOn, note: block.note } });
        }

        if (method === 'PATCH') {
            const id = Number(body.id);
            if (!Number.isInteger(id) || (body.status !== 'active' && body.status !== 'archived')) return json(400, { error: 'id and status (active or archived) are required.' });
            const [row] = await db.update(stayTypes).set({ status: body.status, updatedAt: new Date() }).where(and(eq(stayTypes.id, id), eq(stayTypes.organisationId, orgId))).returning();
            if (!row) return json(404, { error: 'Not found.' });
            const view = (await ownerView(db, orgId, today, base)).find((s) => s.id === id);
            return json(200, { stay: view });
        }

        if (method === 'POST' || method === 'PUT') {
            const id = method === 'PUT' ? Number(body.id) : null;
            if (method === 'PUT' && !Number.isInteger(id)) return json(400, { error: 'id is required.' });
            // The chat names only what changes: lay it over what is saved (never over a door code it can't see).
            if (method === 'PUT' && body.partial === true) {
                const current = (await ownerView(db, orgId, today, base)).find((x) => x.id === id);
                if (!current) return json(404, { error: 'Not found.' });
                const { partial: _p, id: _i, ...changes } = body;
                body = { ...inputFromView(current), ...changes, id };
            }
            const stay = cleanStayType(body);
            if (!stay.ok) return json(400, { error: stay.message });
            const cancellation = cleanCancellation(body.cancellation);
            if (!cancellation.ok) return json(400, { error: cancellation.message });
            const parts = checkParts(body, stay.value.stayType);
            if (!parts.ok) return json(400, { error: parts.error });
            if (method === 'POST') {
                const count = (await db.select({ id: stayTypes.id }).from(stayTypes).where(eq(stayTypes.organisationId, orgId))).length;
                if (count >= MAX_STAYS) return json(409, { error: `Up to ${MAX_STAYS} can be added.` });
            } else {
                const [own] = await db.select({ stayType: stayTypes.stayType }).from(stayTypes).where(and(eq(stayTypes.id, id!), eq(stayTypes.organisationId, orgId))).limit(1);
                if (!own) return json(404, { error: 'Not found.' });
                if (own.stayType !== stay.value.stayType && await hasGuestsToCome(db, orgId, id!, today)) {
                    return json(409, { error: 'Guests are booked here, so it can\'t switch between a whole property and rooms. Add a new one instead.' });
                }
            }
            const row = await saveStayType(db, orgId, id, { ...stay.value, cancellation: cancellation.value });
            if (!row) return json(404, { error: 'Not found.' });
            await replaceStayRates(db, orgId, row.id, parts.rates);
            await replaceStayFees(db, orgId, row.id, parts.fees);
            if (parts.rooms) {
                const r = await setRoomNames(db, orgId, row.id, parts.rooms, today);
                if (!r.ok) return json(409, { error: r.message, stay: (await ownerView(db, orgId, today, base)).find((s) => s.id === row.id) });
            }
            const view = (await ownerView(db, orgId, today, base)).find((s) => s.id === row.id);
            return json(method === 'POST' ? 201 : 200, { stay: view });
        }
        return json(405, { error: 'Method Not Allowed' });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A database without db/z-stays.sql yet.
        if (/relation "stay_|column .*(stay_type_id|check_in)/.test(msg)) return json(503, { error: 'Stays aren\'t switched on for this workspace yet. Please try again later.' });
        console.error('[stays] failed', msg);
        return json(500, { error: 'Something went wrong. Please try again.' });
    }
});
