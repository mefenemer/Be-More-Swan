// src/utils/stay-quote.ts — what a stay costs, when it is paid, and what a cancellation refunds.
// PURE (no database). docs/holiday-lets-plan.md §5. tests/stays.test.ts.
//
// ⚠️ The price is worked out AGAIN on the server at the moment of booking (stays.ts createStay), with
// this same function. A quote shown on a page is never trusted.
//
// Dates are calendar dates ('YYYY-MM-DD'); a NIGHT is named by the date it starts on. check_out is the
// departure morning, so a stay of 3 nights from Fri is Fri, Sat, Sun nights, check_out Mon.
// Money is in minor units of the stay type's currency.

import { addDays, dayOf, DATE_RE, type DayKey } from './booking-time';
import { formatMoney } from './product-price';

export interface StayRate {
    name: string;
    /** Both null = the base rate. Otherwise the season covers NIGHTS startsOn..endsOn inclusive. */
    startsOn: string | null;
    endsOn: string | null;
    nightly: number;
    /** Friday and Saturday nights. */
    weekendNightly: number | null;
    /** Every night of a stay of 7 nights or more (wins over the weekend price). */
    weeklyNightly: number | null;
    minNights: number;
    /** Weekdays a stay may START on; null = any. */
    changeoverDays: DayKey[] | null;
}

export type StayFeeKind = 'cleaning' | 'pet' | 'extra_guest' | 'breakfast' | 'other';
export type StayFeePer = 'stay' | 'night' | 'guest_night';
export interface StayFee {
    id: number;
    kind: StayFeeKind;
    label: string;
    amount: number;
    /** stay = once per room booked; night = per room per night; guest_night = per guest per night. */
    per: StayFeePer;
    /** extra_guest only: guests per room included in the price. */
    afterGuests: number | null;
    /** The guest chooses it (pets, optional breakfast). */
    optional: boolean;
}

export interface CancellationStep { days: number; refund: number; }

export interface StayPricing {
    currency: string;
    maxGuests: number;
    /** Off the night's price per room when only one guest is in it (B&B single use). */
    singleDiscount: number | null;
    rates: StayRate[];
    fees: StayFee[];
    depositPercent: number;
    balanceDays: number;
    balanceCollection: 'auto' | 'link';
    damageDeposit: number | null;
    cancellation: CancellationStep[];
}

export interface StayRequest {
    checkIn: string;
    checkOut: string;
    guests: number;
    rooms: number;
    /** Ids of optional fees the guest ticked. */
    extras: number[];
    /** Today in the business's timezone. */
    today: string;
}

export interface QuoteLine { label: string; amount: number; }
export interface StayQuote {
    nights: number;
    currency: string;
    lines: QuoteLine[];
    /** Everything the stay costs (the damage deposit is NOT part of it — it comes back). */
    total: number;
    /** Charged when they book. */
    dueNow: number;
    /** Charged later (0 = paid in full at booking). */
    balance: number;
    balanceDueOn: string | null;
    balanceCollection: 'auto' | 'link' | null;
    /** Refundable; charged with the balance, or now when paid in full. */
    damageDeposit: number;
    damageDepositNow: boolean;
}

export type QuoteResult = { ok: true; quote: StayQuote } | { ok: false; message: string };

/** Nights between two dates (0 or less when the order is wrong). */
export function nightsBetween(checkIn: string, checkOut: string): number {
    return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

/** The rate for one night: the shortest season holding it, else the base rate. */
export function rateForNight(rates: StayRate[], night: string): StayRate | null {
    let best: StayRate | null = null;
    let bestLen = Infinity;
    for (const r of rates) {
        if (r.startsOn && r.endsOn) {
            if (night < r.startsOn || night > r.endsOn) continue;
            const len = nightsBetween(r.startsOn, r.endsOn);
            if (len < bestLen) { best = r; bestLen = len; }
        }
    }
    return best ?? rates.find((r) => !r.startsOn) ?? null;
}

/** The price of one night for one room. */
export function nightPrice(rate: StayRate, night: string, totalNights: number): number {
    if (totalNights >= 7 && rate.weeklyNightly !== null) return rate.weeklyNightly;
    const d = dayOf(night);
    if ((d === 'fri' || d === 'sat') && rate.weekendNightly !== null) return rate.weekendNightly;
    return rate.nightly;
}

/** "From £95 a night" — the lowest nightly price over every rate, for cards and search data. */
export function fromPrice(p: Pick<StayPricing, 'rates' | 'currency'>): string | null {
    const all = p.rates.flatMap((r) => [r.nightly, r.weekendNightly, r.weeklyNightly]).filter((n): n is number => n !== null && n > 0);
    return all.length ? `From ${formatMoney(Math.min(...all), p.currency)} a night` : null;
}

const DAY_NAMES: Record<DayKey, string> = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

/** Rules a stay must keep (dates, minimum nights, changeover day, guests) — before availability. */
export function stayRuleProblem(p: StayPricing, r: Omit<StayRequest, 'extras'>, limits: { minNoticeDays: number; maxAdvanceDays: number }): string | null {
    if (!DATE_RE.test(r.checkIn) || !DATE_RE.test(r.checkOut)) return 'Choose your arrival and departure dates.';
    const nights = nightsBetween(r.checkIn, r.checkOut);
    if (nights < 1) return 'Your departure date must be after your arrival date.';
    if (nights > 90) return 'Stays can be up to 90 nights. Please get in touch for longer.';
    if (r.checkIn < addDays(r.today, limits.minNoticeDays)) {
        return limits.minNoticeDays <= 0 ? 'That arrival date has passed.' : `Please book at least ${limits.minNoticeDays} day${limits.minNoticeDays === 1 ? '' : 's'} before you arrive.`;
    }
    if (r.checkIn > addDays(r.today, limits.maxAdvanceDays)) return 'Those dates are not open for booking yet.';
    if (!Number.isInteger(r.rooms) || r.rooms < 1) return 'Choose how many rooms.';
    if (!Number.isInteger(r.guests) || r.guests < r.rooms) return r.rooms > 1 ? 'Each room needs at least one guest.' : 'Choose how many guests.';
    if (r.guests > p.maxGuests * r.rooms) {
        return r.rooms > 1 ? `Up to ${p.maxGuests} guests per room — ${r.rooms} rooms take up to ${p.maxGuests * r.rooms}.` : `This sleeps up to ${p.maxGuests}.`;
    }
    const first = rateForNight(p.rates, r.checkIn);
    if (!first) return 'Prices for those dates have not been set yet.';
    if (nights < first.minNights) return `The minimum stay for those dates is ${first.minNights} nights.`;
    if (first.changeoverDays && first.changeoverDays.length && !first.changeoverDays.includes(dayOf(r.checkIn))) {
        const names = first.changeoverDays.map((d) => DAY_NAMES[d]);
        return `Stays for those dates start on a ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`}.`;
    }
    return null;
}

/** The full quote. Rules are checked here too, so a quote is never made for dates that break them. */
export function quoteStay(p: StayPricing, r: StayRequest, limits: { minNoticeDays: number; maxAdvanceDays: number }): QuoteResult {
    const problem = stayRuleProblem(p, r, limits);
    if (problem) return { ok: false, message: problem };
    const nights = nightsBetween(r.checkIn, r.checkOut);
    const lines: QuoteLine[] = [];

    // Accommodation: night by night, grouped into lines of the same price.
    const single = p.singleDiscount && r.guests === r.rooms ? p.singleDiscount : 0;
    const groups: Array<{ price: number; count: number }> = [];
    for (let i = 0; i < nights; i++) {
        const night = addDays(r.checkIn, i);
        const rate = rateForNight(p.rates, night);
        if (!rate) return { ok: false, message: 'Prices for some of those nights have not been set yet.' };
        const price = Math.max(0, nightPrice(rate, night, nights) - single);
        const last = groups[groups.length - 1];
        if (last && last.price === price) last.count++; else groups.push({ price, count: 1 });
    }
    const roomWord = r.rooms > 1 ? ` × ${r.rooms} rooms` : '';
    for (const g of groups) {
        lines.push({ label: `${g.count} night${g.count === 1 ? '' : 's'} × ${formatMoney(g.price, p.currency)}${roomWord}`, amount: g.price * g.count * r.rooms });
    }
    if (single) lines[lines.length - 1].label += ' (single use)';

    // Fees: compulsory ones always; optional ones only when ticked.
    for (const f of p.fees) {
        if (f.optional && !r.extras.includes(f.id)) continue;
        let amount = 0;
        let label = f.label;
        if (f.kind === 'extra_guest') {
            const extra = Math.max(0, r.guests - (f.afterGuests ?? p.maxGuests) * r.rooms);
            if (!extra) continue;
            amount = f.amount * extra * (f.per === 'stay' ? 1 : nights);
            label = `${f.label} (${extra} guest${extra === 1 ? '' : 's'})`;
        } else if (f.per === 'stay') amount = f.amount * r.rooms;
        else if (f.per === 'night') amount = f.amount * nights * r.rooms;
        else amount = f.amount * nights * r.guests;
        if (amount > 0) lines.push({ label, amount });
    }

    const total = lines.reduce((s, l) => s + l.amount, 0);
    const damage = p.damageDeposit ?? 0;
    // Deposit now, the rest later — only when they book far enough ahead.
    const daysAhead = nightsBetween(r.today, r.checkIn);
    const split = p.depositPercent > 0 && p.depositPercent < 100 && daysAhead > p.balanceDays && total > 0;
    const dueNow = split ? Math.round(total * p.depositPercent / 100) : total;
    const balance = total - dueNow;
    return {
        ok: true,
        quote: {
            nights, currency: p.currency, lines, total, dueNow, balance,
            balanceDueOn: balance > 0 ? addDays(r.checkIn, -p.balanceDays) : null,
            balanceCollection: balance > 0 ? p.balanceCollection : null,
            damageDeposit: damage,
            damageDepositNow: damage > 0 && balance === 0,
        },
    };
}

/** The % refunded when cancelled `daysBefore` days before check-in (most generous step that applies). */
export function refundPercent(steps: CancellationStep[], daysBefore: number): number {
    let best = 0;
    for (const s of steps) if (daysBefore >= s.days && s.refund > best) best = s.refund;
    return best;
}

/** "Full refund 28+ days before arrival; 50% refund 14+ days before; no refund after that." */
export function describeCancellation(steps: CancellationStep[]): string {
    if (!steps.length) return 'No refund if you cancel.';
    const sorted = [...steps].sort((a, b) => b.days - a.days);
    const parts = sorted.map((s) => `${s.refund === 100 ? 'Full refund' : s.refund === 0 ? 'No refund' : `${s.refund}% refund`} if you cancel ${s.days}+ day${s.days === 1 ? '' : 's'} before arrival`);
    const smallest = sorted[sorted.length - 1];
    if (smallest.days > 0 && smallest.refund > 0) parts.push('no refund after that');
    const text = parts.join('; ');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** The plain-words payment plan shown with the quote and in the confirmation. */
export function describePayment(q: StayQuote, formatDay: (date: string) => string): string[] {
    const m = (n: number) => formatMoney(n, q.currency);
    const out: string[] = [];
    if (q.balance > 0) {
        out.push(`${m(q.dueNow)} now to book.`);
        out.push(q.balanceCollection === 'auto'
            ? `The remaining ${m(q.balance)} will be charged to the same card on ${formatDay(q.balanceDueOn!)}.`
            : `The remaining ${m(q.balance)} is due by ${formatDay(q.balanceDueOn!)}. We'll email you a link to pay it.`);
    } else out.push(`${m(q.total)} now, paid in full.`);
    if (q.damageDeposit > 0) {
        out.push(`A refundable damage deposit of ${m(q.damageDeposit)} is ${q.damageDepositNow ? 'charged now' : 'charged with the remaining balance'}, and returned after your stay.`);
    }
    return out;
}
