// src/utils/stay-clean.ts — what an owner may save about a holiday let or B&B room type, its prices,
// fees and cancellation policy. PURE. The Stays tab and the chat card both save through these, so
// the two can never disagree (docs/holiday-lets-plan.md §2). tests/stays.test.ts.
//
// Money is TYPED in major units (pounds / euros: "95", "€95.50") and stored in minor units.
// Nothing here ever makes a price up: an empty amount is "not set", never zero.

import { DATE_RE, DAY_KEYS, TIME_RE, type DayKey } from './booking-time';
import { cleanCurrency, poundsToPence, PRICE_MAX_PENCE, type PriceCurrency } from './product-price';
import type { CancellationStep, StayFeeKind, StayFeePer } from './stay-quote';

export type Clean<T> = { ok: true; value: T } | { ok: false; message: string };

/** The amenities a stay can list — a closed set, so pages, search data and filters read the same words. */
export const STAY_AMENITIES = {
    wifi: 'Wi-Fi', parking: 'Parking', ev_charger: 'EV charger', kitchen: 'Kitchen', washing_machine: 'Washing machine',
    dishwasher: 'Dishwasher', tv: 'TV', heating: 'Heating', air_conditioning: 'Air conditioning', log_burner: 'Log burner',
    garden: 'Garden', hot_tub: 'Hot tub', pool: 'Pool', sea_view: 'Sea view', bbq: 'Barbecue', cot: 'Cot',
    high_chair: 'High chair', step_free: 'Step-free access', pets_allowed: 'Pets allowed', workspace: 'Workspace',
    towels_linen: 'Towels and bed linen', breakfast: 'Breakfast', en_suite: 'En-suite',
} as const;
export type StayAmenity = keyof typeof STAY_AMENITIES;

export interface StayImage { assetId: number; alt: string; }

export interface CleanStayType {
    stayType: 'whole' | 'room';
    name: string;
    summary: string | null;
    description: string | null;
    maxGuests: number;
    bedrooms: number | null;
    bathrooms: number | null;
    beds: string | null;
    amenities: StayAmenity[];
    houseRules: string | null;
    address: string | null;
    licenceNumber: string | null;
    images: StayImage[];
    checkInTime: string;
    checkOutTime: string;
    mode: 'instant' | 'request';
    arrivalDetails: string | null;
    arrivalDetailsDays: number;
    breakfast: 'none' | 'included' | 'optional';
    singleDiscount: number | null;
    currency: PriceCurrency;
    depositPercent: number;
    balanceDays: number;
    balanceCollection: 'auto' | 'link';
    damageDeposit: number | null;
    damageDepositReturnDays: number;
    minNoticeDays: number;
    maxAdvanceDays: number;
    gapNights: number;
}

const text = (v: unknown, max: number): string | null => {
    const t = String(v ?? '').replace(/\r\n/g, '\n').trim();
    return t ? t.slice(0, max) : null;
};
const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';

/** A whole number in [min, max], `fallback` when left empty, null when it isn't one. */
function int(v: unknown, min: number, max: number, fallback: number | null): number | null | undefined {
    if (blank(v)) return fallback;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Money typed in major units → minor units; null = left empty; undefined = not money. */
function money(v: unknown): number | null | undefined {
    if (blank(v)) return null;
    const p = poundsToPence(v);
    return p === null || p > PRICE_MAX_PENCE ? undefined : p;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T | undefined {
    if (blank(v)) return fallback;
    const s = String(v).trim().toLowerCase() as T;
    return allowed.includes(s) ? s : undefined;
}

export function slugifyStay(name: string): string {
    const s = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
    return s || 'stay';
}

export function cleanStayType(input: Record<string, unknown>): Clean<CleanStayType> {
    const bad = (message: string): Clean<CleanStayType> => ({ ok: false, message });
    const name = text(input.name, 120);
    if (!name) return bad('Give it a name, for example "Seaview Cottage" or "Double room with sea view".');
    const stayType = pick(input.stayType, ['whole', 'room'] as const, 'whole');
    if (!stayType) return bad('Choose whether guests book the whole place or a room.');
    const maxGuests = int(input.maxGuests, 1, 50, 2);
    if (!maxGuests) return bad('How many guests can stay? Between 1 and 50.');
    const bedrooms = int(input.bedrooms, 0, 50, null);
    const bathrooms = int(input.bathrooms, 0, 50, null);
    if (bedrooms === undefined || bathrooms === undefined) return bad('Bedrooms and bathrooms are whole numbers.');
    const checkInTime = blank(input.checkInTime) ? '16:00' : String(input.checkInTime).trim();
    const checkOutTime = blank(input.checkOutTime) ? '10:00' : String(input.checkOutTime).trim();
    if (!TIME_RE.test(checkInTime) || !TIME_RE.test(checkOutTime)) return bad('Check-in and check-out times look like 16:00.');
    const mode = pick(input.mode, ['instant', 'request'] as const, 'request');
    if (!mode) return bad('Choose instant booking or "request to book".');
    const breakfast = pick(input.breakfast, ['none', 'included', 'optional'] as const, 'none');
    if (!breakfast) return bad('Breakfast is none, included or optional.');
    const balanceCollection = pick(input.balanceCollection, ['auto', 'link'] as const, 'link');
    if (!balanceCollection) return bad('Choose how the balance is collected: charge the card automatically, or email a link.');
    const currency = blank(input.currency) ? 'GBP' : cleanCurrency(input.currency);
    if (!currency) return bad('Prices can be in pounds, euros, US, Australian or Canadian dollars.');
    const depositPercent = int(input.depositPercent, 0, 100, 0);
    if (depositPercent === undefined || depositPercent === null) return bad('The deposit is a percentage between 0 and 100.');
    const balanceDays = int(input.balanceDays, 0, 365, 28);
    if (balanceDays === undefined || balanceDays === null) return bad('When the balance is due: 0 to 365 days before arrival.');
    const singleDiscount = money(input.singleDiscount);
    const damageDeposit = money(input.damageDeposit);
    if (singleDiscount === undefined || damageDeposit === undefined) return bad('Amounts look like 95 or 95.50.');
    if (damageDeposit !== null && damageDeposit < 100) return bad('A damage deposit is at least 1 (or leave it empty for none).');
    const arrivalDetailsDays = int(input.arrivalDetailsDays, 0, 30, 3);
    const damageDepositReturnDays = int(input.damageDepositReturnDays, 1, 30, 7);
    const minNoticeDays = int(input.minNoticeDays, 0, 60, 1);
    const maxAdvanceDays = int(input.maxAdvanceDays, 1, 1095, 540);
    const gapNights = int(input.gapNights, 0, 7, 0);
    if ([arrivalDetailsDays, damageDepositReturnDays, minNoticeDays, maxAdvanceDays, gapNights].some((n) => n === undefined || n === null)) {
        return bad('One of the booking rules is out of range.');
    }
    const amenities = Array.isArray(input.amenities)
        ? [...new Set((input.amenities as unknown[]).map((a) => String(a)).filter((a): a is StayAmenity => Object.prototype.hasOwnProperty.call(STAY_AMENITIES, a)))]
        : [];
    const images: StayImage[] = [];
    if (Array.isArray(input.images)) {
        for (const im of (input.images as Array<Record<string, unknown>>).slice(0, 30)) {
            const assetId = Number(im?.assetId);
            const alt = text(im?.alt, 200);
            if (!Number.isInteger(assetId) || assetId <= 0) continue;
            if (!alt) return bad('Every photo needs a short description for people who can\'t see it.');
            images.push({ assetId, alt });
        }
    }
    return {
        ok: true,
        value: {
            stayType, name, summary: text(input.summary, 300), description: text(input.description, 5000), maxGuests,
            bedrooms, bathrooms, beds: text(input.beds, 200), amenities, houseRules: text(input.houseRules, 3000),
            address: text(input.address, 300), licenceNumber: text(input.licenceNumber, 80), images, checkInTime, checkOutTime, mode,
            arrivalDetails: text(input.arrivalDetails, 3000), arrivalDetailsDays: arrivalDetailsDays!, breakfast, singleDiscount, currency,
            depositPercent, balanceDays, balanceCollection, damageDeposit, damageDepositReturnDays: damageDepositReturnDays!,
            minNoticeDays: minNoticeDays!, maxAdvanceDays: maxAdvanceDays!, gapNights: gapNights!,
        },
    };
}

export interface CleanStayRate {
    name: string; startsOn: string | null; endsOn: string | null; nightly: number;
    weekendNightly: number | null; weeklyNightly: number | null; minNights: number; changeoverDays: DayKey[] | null;
}

export function cleanStayRate(input: Record<string, unknown>): Clean<CleanStayRate> {
    const bad = (message: string): Clean<CleanStayRate> => ({ ok: false, message });
    const startsOn = blank(input.startsOn) ? null : String(input.startsOn).trim();
    const endsOn = blank(input.endsOn) ? null : String(input.endsOn).trim();
    if ((startsOn === null) !== (endsOn === null)) return bad('A season needs both a first and a last night (or neither, for the standard price).');
    if (startsOn && (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn!))) return bad('Dates look like 2027-07-01.');
    if (startsOn && endsOn! < startsOn) return bad('The season\'s last night is before its first.');
    const nightly = money(input.nightly);
    if (nightly === null || nightly === undefined) return bad('Set the price per night.');
    const weekendNightly = money(input.weekendNightly);
    const weeklyNightly = money(input.weeklyNightly);
    if (weekendNightly === undefined || weeklyNightly === undefined) return bad('Amounts look like 95 or 95.50.');
    const minNights = int(input.minNights, 1, 60, 1);
    if (!minNights) return bad('The minimum stay is 1 to 60 nights.');
    const days = Array.isArray(input.changeoverDays)
        ? [...new Set((input.changeoverDays as unknown[]).map((d) => String(d).toLowerCase().slice(0, 3)).filter((d): d is DayKey => (DAY_KEYS as readonly string[]).includes(d)))]
        : [];
    return {
        ok: true,
        value: {
            name: text(input.name, 60) ?? (startsOn ? 'Season' : 'Standard'), startsOn, endsOn, nightly, weekendNightly, weeklyNightly, minNights,
            changeoverDays: days.length && days.length < 7 ? days : null,
        },
    };
}

export interface CleanStayFee { kind: StayFeeKind; label: string; amount: number; per: StayFeePer; afterGuests: number | null; optional: boolean; }
const FEE_LABEL: Record<StayFeeKind, string> = { cleaning: 'Cleaning', pet: 'Pet', extra_guest: 'Extra guest', breakfast: 'Breakfast', other: 'Extra' };

export function cleanStayFee(input: Record<string, unknown>): Clean<CleanStayFee> {
    const kind = pick(input.kind, ['cleaning', 'pet', 'extra_guest', 'breakfast', 'other'] as const, 'other');
    if (!kind || blank(input.kind)) return { ok: false, message: 'Choose what the charge is for.' };
    const amount = money(input.amount);
    if (amount === null || amount === undefined) return { ok: false, message: 'Set the amount, for example 60.' };
    const per = pick(input.per, ['stay', 'night', 'guest_night'] as const, kind === 'breakfast' ? 'guest_night' : kind === 'extra_guest' ? 'night' : 'stay');
    if (!per) return { ok: false, message: 'Charged per stay, per night, or per guest per night.' };
    const afterGuests = kind === 'extra_guest' ? int(input.afterGuests, 0, 50, null) : null;
    if (afterGuests === undefined) return { ok: false, message: 'How many guests are included before the extra-guest charge?' };
    return {
        ok: true,
        value: { kind, label: text(input.label, 60) ?? FEE_LABEL[kind], amount, per, afterGuests, optional: kind === 'pet' || kind === 'breakfast' ? true : input.optional === true },
    };
}

/** Days-before → % refunded. Sorted most days first; one step per number of days (the first given wins). */
export function cleanCancellation(input: unknown): Clean<CancellationStep[]> {
    if (!Array.isArray(input)) return { ok: true, value: [] };
    const seen = new Set<number>();
    const out: CancellationStep[] = [];
    for (const s of input.slice(0, 6) as Array<Record<string, unknown>>) {
        const days = Number(s?.days);
        const refund = Number(s?.refund);
        if (!Number.isInteger(days) || days < 0 || days > 365 || !Number.isInteger(refund) || refund < 0 || refund > 100) {
            return { ok: false, message: 'Each cancellation step is a number of days (0–365) and a refund (0–100%).' };
        }
        if (seen.has(days)) continue;
        seen.add(days);
        out.push({ days, refund });
    }
    return { ok: true, value: out.sort((a, b) => b.days - a.days) };
}
