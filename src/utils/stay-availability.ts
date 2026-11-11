// src/utils/stay-availability.ts — which houses / rooms are free for which nights, and which one a new
// booking gets. PURE (no database). docs/holiday-lets-plan.md §3. tests/stays.test.ts.
//
// A unit is the actual house or room. A whole property has one; a B&B room type has one per room.
// A guest keeps ONE unit for the whole stay — never moved from room to room halfway through.
// Everything is [checkIn, checkOut): the departure morning is free for the next arrival, unless the
// owner asks for turnover nights (gapNights) after each stay.

import { addDays } from './booking-time';
import { nightsBetween } from './stay-quote';

export interface StayUnit { id: number; name: string; }
/** Something that holds a unit: a booking, an owner's block, or (phase 2) a channel's booking. */
export interface UnitHold { unitId: number; checkIn: string; checkOut: string; }

/** Whether a unit is free for [checkIn, checkOut), keeping `gapNights` clear after every stay (ours included). */
export function unitFree(unitId: number, holds: UnitHold[], checkIn: string, checkOut: string, gapNights = 0): boolean {
    const end = addDays(checkOut, gapNights);
    for (const h of holds) {
        if (h.unitId !== unitId) continue;
        if (h.checkIn < end && checkIn < addDays(h.checkOut, gapNights)) return false;
    }
    return true;
}

/** Units free for the whole stay. */
export function freeUnits(units: StayUnit[], holds: UnitHold[], checkIn: string, checkOut: string, gapNights = 0): StayUnit[] {
    return units.filter((u) => unitFree(u.id, holds, checkIn, checkOut, gapNights));
}

/**
 * The units a new booking of `rooms` rooms gets, or null when not enough are free for every night.
 * Rooms are packed tightly: a room whose last guest leaves (or next guest arrives) closest to this stay
 * is chosen first, so the empty runs left over are as long, and as sellable, as they can be.
 */
export function assignUnits(units: StayUnit[], holds: UnitHold[], checkIn: string, checkOut: string, rooms: number, gapNights = 0): StayUnit[] | null {
    const free = freeUnits(units, holds, checkIn, checkOut, gapNights);
    if (free.length < rooms) return null;
    const slack = (u: StayUnit) => {
        let before = Infinity;
        let after = Infinity;
        for (const h of holds) {
            if (h.unitId !== u.id) continue;
            if (h.checkOut <= checkIn) before = Math.min(before, nightsBetween(h.checkOut, checkIn));
            if (h.checkIn >= checkOut) after = Math.min(after, nightsBetween(checkOut, h.checkIn));
        }
        return Math.min(before, 400) + Math.min(after, 400);
    };
    return free
        .map((u, i) => ({ u, i, s: slack(u) }))
        .sort((a, b) => a.s - b.s || a.i - b.i)
        .slice(0, rooms)
        .map((x) => x.u);
}

/**
 * For a calendar: how many units are free on each night from `from` for `count` nights. A night shows
 * as free while at least one unit is. Turnover nights are left out here (they depend on which stay
 * is chosen); the booking step checks them.
 */
export function freeByNight(units: StayUnit[], holds: UnitHold[], from: string, count: number): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < count; i++) {
        const night = addDays(from, i);
        const next = addDays(night, 1);
        out.set(night, units.filter((u) => unitFree(u.id, holds, night, next, 0)).length);
    }
    return out;
}

/** Whether `rooms` units could take any stay starting on `checkIn` (a calendar's "arrive here" link). */
export function canArriveOn(units: StayUnit[], holds: UnitHold[], checkIn: string, minNights: number, rooms: number, gapNights = 0): boolean {
    return freeUnits(units, holds, checkIn, addDays(checkIn, Math.max(1, minNights)), gapNights).length >= rooms;
}
