// src/utils/stays-prompt.ts — what the Website Assistant's chat knows about the owner's holiday lets and
// B&B rooms (Business Information ▸ Stays) and the stays booked, so it can propose stay_setup,
// stay_block and stay_damage cards with real ids. docs/holiday-lets-plan.md §6. tests/stays-chat.test.ts.
//
// ⚠️ Arrival details (door codes, Wi-Fi passwords) never go into a prompt: the chat is told only
// whether they are set. Money is shown as the owner typed it (major units).

import { and, asc, eq, gte, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookings } from '../../db/schema';
import { loadStays, type LoadedStay } from './stays';
import { describeBooking } from './bookings';
import { stayMoneyView } from './stay-charges';
import { describeCancellation } from './stay-quote';
import { formatMoney } from './product-price';

type Db = ReturnType<typeof getDb>;
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : '');

/** One stay as a prompt line — pure, for tests. */
export function stayLine(s: LoadedStay): string {
    const r = s.row;
    const m = (n: number | null) => (n === null || n === undefined ? null : formatMoney(n, r.currency));
    const rates = s.rates.map((x) => `${x.name}${x.startsOn ? ` ${x.startsOn}→${x.endsOn}` : ' (standard)'} ${m(x.nightly)}/night${x.weekendNightly !== null ? `, Fri–Sat ${m(x.weekendNightly)}` : ''}${x.weeklyNightly !== null ? `, 7+ nights ${m(x.weeklyNightly)}` : ''}, min ${x.minNights} night(s)${x.changeoverDays ? `, starts ${x.changeoverDays.join('/')}` : ''}`);
    const fees = s.fees.map((f) => `${f.label} ${m(f.amount)} ${{ stay: 'per stay', night: 'per night', guest_night: 'per guest per night' }[f.per]}${f.optional ? ' (guest chooses)' : ''}`);
    const pay = [
        r.depositPercent ? `${r.depositPercent}% deposit, rest due ${r.balanceDays} days before arrival (${r.balanceCollection === 'auto' ? 'card charged automatically' : 'payment link emailed'})` : 'paid in full at booking',
        r.damageDeposit ? `damage deposit ${m(r.damageDeposit)}, returned ${r.damageDepositReturnDays} days after check-out unless they keep part` : 'no damage deposit',
    ];
    return `- stayId ${r.id}: "${r.name}" — ${r.stayType === 'room' ? `room type with rooms ${s.units.map((u) => `${u.name} (unitId ${u.id})`).join(', ') || 'none'}` : `whole property (unitId ${s.units[0]?.id ?? '?'})`}${r.status === 'archived' ? ', ARCHIVED (not bookable)' : ''}. `
        + `Sleeps ${r.maxGuests}${r.stayType === 'room' ? ' per room' : ''}${r.bedrooms !== null ? `, ${r.bedrooms} bedrooms` : ''}${r.bathrooms !== null ? `, ${r.bathrooms} bathrooms` : ''}${r.beds ? `, beds: ${r.beds}` : ''}. `
        + `Check-in ${r.checkInTime}, check-out ${r.checkOutTime}. ${r.mode === 'instant' ? 'Confirmed straight away' : 'Owner confirms each booking'}. Currency ${r.currency}. `
        + `Prices: ${rates.length ? rates.join('; ') : 'NONE SET — not bookable until a standard price is added'}. `
        + `Extra charges: ${fees.length ? fees.join('; ') : 'none'}. Payment: ${pay.join('; ')}. Cancellation: ${describeCancellation(Array.isArray(r.cancellation) ? r.cancellation as never : [])} `
        + `Notice ${r.minNoticeDays} day(s), up to ${r.maxAdvanceDays} days ahead, ${r.gapNights} night(s) kept free after each stay. `
        + `Photos: ${(Array.isArray(r.images) ? r.images.length : 0)}. Amenities: ${(Array.isArray(r.amenities) ? r.amenities as string[] : []).join(', ') || 'none ticked'}. `
        + `House rules: ${r.houseRules ? `"${clip(r.houseRules, 160)}"` : 'none'}. Licence number: ${r.licenceNumber || 'none'}. Arrival details: ${r.arrivalDetails ? 'set (private — never repeat them)' : 'not set'}.`;
}

/** The stays block of the Website Assistant's snapshot. Never throws (a missing table reads as "not set up"). */
export async function staysForPrompt(db: Db, orgId: number, now = new Date()): Promise<string> {
    let all: LoadedStay[];
    try { all = await loadStays(db, orgId); } catch { return 'Stays (holiday lets, B&B rooms): not available for this workspace yet.'; }
    if (!all.length) return 'Stays (Business Information ▸ Stays): none set up. If they let a holiday home or B&B rooms, offer to set one up with a stay_setup card from what they tell you.';
    const lines = ['Their stays (Business Information ▸ Stays — a "stays" website section shows the active ones, each with its own page and calendar):', ...all.map(stayLine)];
    const today = now.toISOString().slice(0, 10);
    const rows = await db.select().from(bookings).where(and(eq(bookings.organisationId, orgId), eq(bookings.kind, 'stay'),
        or(gte(bookings.checkOut, today), eq(bookings.damageDepositStatus, 'held')))).orderBy(asc(bookings.checkIn)).limit(40).catch(() => []);
    const live = rows.filter((b) => ['pending', 'confirmed'].includes(b.status) || b.damageDepositStatus === 'held');
    if (live.length) {
        lines.push('Stays booked (upcoming, or with a damage deposit still held):');
        for (const b of live) {
            const { what, when } = describeBooking(b, 'UTC');
            const money = stayMoneyView(b, now);
            lines.push(`- bookingId ${b.id}: ${b.customerName}, ${what}, ${when}, ${b.status}${b.resourceName ? `, ${b.resourceName}` : ''}${money.balance ? `. ${money.balance}` : ''}${money.damage ? `. ${money.damage}${money.damageHeld ? (money.canKeep ? ' (stay_damage card possible)' : ' (part can be kept only once the stay begins)') : ''}` : ''}.`);
        }
    } else lines.push('No stays booked ahead.');
    return lines.join('\n');
}
