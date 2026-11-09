// tests/stays.test.ts
// Holiday lets and B&B rooms (docs/holiday-lets-plan.md): the price (stay-quote.ts), which house or
// room is free and which one a booking gets (stay-availability.ts), what an owner may save
// (stay-clean.ts), and the wiring that keeps a room from being booked twice (stays.ts).
//
// Run:  npx tsx tests/stays.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    describeCancellation, describePayment, fromPrice, nightsBetween, quoteStay, rateForNight, refundPercent, stayRuleProblem,
    type StayPricing, type StayRate,
} from '../src/utils/stay-quote';
import { assignUnits, canArriveOn, freeByNight, freeUnits, unitFree, type UnitHold } from '../src/utils/stay-availability';
import { cleanCancellation, cleanStayFee, cleanStayRate, cleanStayType, slugifyStay } from '../src/utils/stay-clean';
import { WORKSPACE_TABLES } from '../src/utils/workspace-export';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const BASE: StayRate = { name: 'Standard', startsOn: null, endsOn: null, nightly: 10000, weekendNightly: 12000, weeklyNightly: 9000, minNights: 2, changeoverDays: null };
const SUMMER: StayRate = { name: 'Summer', startsOn: '2027-07-01', endsOn: '2027-08-31', nightly: 15000, weekendNightly: null, weeklyNightly: null, minNights: 7, changeoverDays: ['sat'] };
const COTTAGE: StayPricing = {
    currency: 'GBP', maxGuests: 4, singleDiscount: null, rates: [BASE, SUMMER],
    fees: [
        { id: 1, kind: 'cleaning', label: 'Cleaning', amount: 5000, per: 'stay', afterGuests: null, optional: false },
        { id: 2, kind: 'pet', label: 'Dog', amount: 2500, per: 'stay', afterGuests: null, optional: true },
    ],
    depositPercent: 25, balanceDays: 28, balanceCollection: 'link', damageDeposit: 20000,
    cancellation: [{ days: 28, refund: 100 }, { days: 14, refund: 50 }],
};
const LIMITS = { minNoticeDays: 1, maxAdvanceDays: 540 };
const TODAY = '2026-11-09'; // a Monday
const req = (over: Record<string, unknown> = {}) => ({ checkIn: '2027-03-05', checkOut: '2027-03-08', guests: 2, rooms: 1, extras: [] as number[], today: TODAY, ...over });

console.log('\nstay-quote');

check('nights are counted between dates, across the clocks changing', () => {
    assert.strictEqual(nightsBetween('2027-03-26', '2027-03-29'), 3); // UK clocks go forward 28 Mar 2027
    assert.strictEqual(nightsBetween('2027-03-08', '2027-03-05'), -3);
});

check('the shortest season holding a night wins; the base rate covers the rest', () => {
    const XMAS: StayRate = { ...BASE, name: 'Christmas', startsOn: '2027-12-20', endsOn: '2027-12-27', nightly: 20000 };
    const WINTER: StayRate = { ...BASE, name: 'Winter', startsOn: '2027-12-01', endsOn: '2028-02-28', nightly: 8000 };
    assert.strictEqual(rateForNight([BASE, WINTER, XMAS], '2027-12-24')?.name, 'Christmas');
    assert.strictEqual(rateForNight([BASE, WINTER, XMAS], '2027-12-28')?.name, 'Winter');
    assert.strictEqual(rateForNight([BASE, WINTER, XMAS], '2027-11-30')?.name, 'Standard');
    assert.strictEqual(rateForNight([WINTER], '2027-11-30'), null);
});

check('Fri and Sat nights take the weekend price; cleaning added once; deposit now, balance later', () => {
    const r = quoteStay(COTTAGE, req(), LIMITS); // Fri 5 Mar → Mon 8 Mar: Fri, Sat, Sun
    assert.ok(r.ok, !r.ok ? r.message : '');
    if (!r.ok) return;
    const q = r.quote;
    assert.strictEqual(q.nights, 3);
    assert.deepStrictEqual(q.lines.map((l) => l.amount), [24000, 10000, 5000]);
    assert.strictEqual(q.lines[0].label, '2 nights × £120');
    assert.strictEqual(q.total, 39000);
    assert.strictEqual(q.dueNow, 9750);
    assert.strictEqual(q.balance, 29250);
    assert.strictEqual(q.balanceDueOn, '2027-02-05');
    assert.strictEqual(q.balanceCollection, 'link');
    assert.strictEqual(q.damageDeposit, 20000);
    assert.strictEqual(q.damageDepositNow, false, 'damage deposit goes with the balance');
});

check('a week or more takes the weekly price on every night', () => {
    const r = quoteStay(COTTAGE, req({ checkIn: '2027-03-05', checkOut: '2027-03-12' }), LIMITS);
    assert.ok(r.ok);
    if (r.ok) assert.deepStrictEqual(r.quote.lines[0], { label: '7 nights × £90', amount: 63000 });
});

check('booked inside the balance window: pay in full now, damage deposit now too', () => {
    const r = quoteStay(COTTAGE, req({ checkIn: '2026-11-20', checkOut: '2026-11-23', today: TODAY }), LIMITS);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual(r.quote.balance, 0);
    assert.strictEqual(r.quote.dueNow, r.quote.total);
    assert.strictEqual(r.quote.balanceDueOn, null);
    assert.strictEqual(r.quote.balanceCollection, null);
    assert.strictEqual(r.quote.damageDepositNow, true);
});

check('optional fees only when ticked', () => {
    const without = quoteStay(COTTAGE, req(), LIMITS);
    const withDog = quoteStay(COTTAGE, req({ extras: [2] }), LIMITS);
    assert.ok(without.ok && withDog.ok);
    if (without.ok && withDog.ok) {
        assert.strictEqual(withDog.quote.total - without.quote.total, 2500);
        assert.ok(withDog.quote.lines.some((l) => l.label === 'Dog'));
    }
});

check('season rules: minimum nights and changeover day come from the arrival night', () => {
    assert.match(stayRuleProblem(COTTAGE, req({ checkIn: '2027-07-03', checkOut: '2027-07-06' }), LIMITS) ?? '', /minimum stay for those dates is 7 nights/);
    assert.match(stayRuleProblem(COTTAGE, req({ checkIn: '2027-07-05', checkOut: '2027-07-12' }), LIMITS) ?? '', /start on a Saturday/);
    assert.strictEqual(stayRuleProblem(COTTAGE, req({ checkIn: '2027-07-03', checkOut: '2027-07-10' }), LIMITS), null);
    assert.match(stayRuleProblem(COTTAGE, req({ checkIn: '2027-03-05', checkOut: '2027-03-06' }), LIMITS) ?? '', /minimum stay.*2 nights/);
});

check('date, notice, guests and rooms rules', () => {
    assert.match(stayRuleProblem(COTTAGE, req({ checkOut: '2027-03-05' }), LIMITS) ?? '', /after your arrival/);
    assert.match(stayRuleProblem(COTTAGE, req({ checkIn: TODAY, checkOut: '2026-11-12' }), LIMITS) ?? '', /at least 1 day/);
    assert.match(stayRuleProblem(COTTAGE, req({ checkIn: '2029-01-05', checkOut: '2029-01-08' }), LIMITS) ?? '', /not open/);
    assert.match(stayRuleProblem(COTTAGE, req({ guests: 5 }), LIMITS) ?? '', /sleeps up to 4/);
    assert.match(stayRuleProblem(COTTAGE, req({ guests: 1, rooms: 2 }), LIMITS) ?? '', /at least one guest/);
    assert.match(stayRuleProblem(COTTAGE, req({ checkIn: 'soon' }), LIMITS) ?? '', /Choose your arrival/);
    assert.match(stayRuleProblem({ ...COTTAGE, rates: [SUMMER] }, req(), LIMITS) ?? '', /not been set/);
});

check('B&B: several rooms multiply nights and per-room fees; single use takes the discount', () => {
    const BNB: StayPricing = {
        ...COTTAGE, maxGuests: 2, singleDiscount: 2000, depositPercent: 0, damageDeposit: null,
        rates: [{ ...BASE, weekendNightly: null, weeklyNightly: null, minNights: 1 }],
        fees: [{ id: 9, kind: 'breakfast', label: 'Breakfast', amount: 1200, per: 'guest_night', afterGuests: null, optional: true }],
    };
    const two = quoteStay(BNB, req({ checkIn: '2027-03-01', checkOut: '2027-03-03', guests: 4, rooms: 2, extras: [9] }), LIMITS);
    assert.ok(two.ok);
    if (two.ok) {
        assert.deepStrictEqual(two.quote.lines, [
            { label: '2 nights × £100 × 2 rooms', amount: 40000 },
            { label: 'Breakfast', amount: 9600 },
        ]);
        assert.strictEqual(two.quote.dueNow, two.quote.total, 'no deposit set = pay in full');
        assert.strictEqual(two.quote.damageDeposit, 0);
    }
    const solo = quoteStay(BNB, req({ checkIn: '2027-03-01', checkOut: '2027-03-03', guests: 1 }), LIMITS);
    assert.ok(solo.ok);
    if (solo.ok) assert.deepStrictEqual(solo.quote.lines[0], { label: '2 nights × £80 (single use)', amount: 16000 });
});

check('extra guests are charged above the included number per room, per night', () => {
    const p: StayPricing = { ...COTTAGE, maxGuests: 6, fees: [{ id: 3, kind: 'extra_guest', label: 'Extra guest', amount: 1500, per: 'night', afterGuests: 4, optional: false }] };
    const r = quoteStay(p, req({ guests: 6 }), LIMITS);
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.quote.lines.some((l) => l.label === 'Extra guest (2 guests)' && l.amount === 9000));
    const four = quoteStay(p, req({ guests: 4 }), LIMITS);
    assert.ok(four.ok && !four.quote.lines.some((l) => l.label.startsWith('Extra guest')));
});

check('euros print in euros', () => {
    const r = quoteStay({ ...COTTAGE, currency: 'EUR' }, req(), LIMITS);
    assert.ok(r.ok && r.quote.lines[0].label.includes('€120'));
    assert.strictEqual(fromPrice({ rates: [BASE, SUMMER], currency: 'EUR' }), 'From €90 a night');
    assert.strictEqual(fromPrice({ rates: [], currency: 'GBP' }), null);
});

check('cancellation: the most generous step that applies', () => {
    assert.strictEqual(refundPercent(COTTAGE.cancellation, 40), 100);
    assert.strictEqual(refundPercent(COTTAGE.cancellation, 28), 100);
    assert.strictEqual(refundPercent(COTTAGE.cancellation, 20), 50);
    assert.strictEqual(refundPercent(COTTAGE.cancellation, 3), 0);
    assert.strictEqual(refundPercent([], 100), 0);
    assert.strictEqual(describeCancellation(COTTAGE.cancellation),
        'Full refund if you cancel 28+ days before arrival; 50% refund if you cancel 14+ days before arrival; no refund after that.');
    assert.strictEqual(describeCancellation([]), 'No refund if you cancel.');
});

check('the payment plan reads the way the owner set balance collection', () => {
    const r = quoteStay(COTTAGE, req(), LIMITS);
    assert.ok(r.ok);
    if (!r.ok) return;
    const day = (d: string) => d;
    const link = describePayment(r.quote, day);
    assert.match(link[1], /due by 2027-02-05\. We'll email you a link/);
    assert.match(link[2], /refundable damage deposit of £200 is charged with the remaining balance/);
    const auto = describePayment({ ...r.quote, balanceCollection: 'auto' }, day);
    assert.match(auto[1], /charged to the same card on 2027-02-05/);
});

console.log('\nstay-availability');

const ROOMS = [{ id: 1, name: 'Room 1' }, { id: 2, name: 'Room 2' }, { id: 3, name: 'Room 3' }];
const HOLDS: UnitHold[] = [
    { unitId: 1, checkIn: '2027-03-01', checkOut: '2027-03-04' },
    { unitId: 2, checkIn: '2027-03-03', checkOut: '2027-03-06' },
];

check('the departure morning is free for the next arrival', () => {
    assert.strictEqual(unitFree(1, HOLDS, '2027-03-04', '2027-03-06'), true);
    assert.strictEqual(unitFree(1, HOLDS, '2027-03-03', '2027-03-05'), false);
    assert.strictEqual(unitFree(1, HOLDS, '2027-02-27', '2027-03-01'), true, 'leaving the morning the next guest arrives');
});

check('turnover nights are kept clear after every stay, ours included', () => {
    assert.strictEqual(unitFree(1, HOLDS, '2027-03-04', '2027-03-06', 1), false, 'needs a night after the last stay');
    assert.strictEqual(unitFree(1, HOLDS, '2027-03-05', '2027-03-07', 1), true);
    assert.strictEqual(unitFree(1, HOLDS, '2027-02-27', '2027-03-01', 1), false, 'needs a night before the next stay');
});

check('a guest keeps one room for the whole stay', () => {
    // Room 1 is free from the 4th, room 2 until the 3rd: nobody can be moved between them.
    const holds: UnitHold[] = [{ unitId: 1, checkIn: '2027-03-01', checkOut: '2027-03-04' }, { unitId: 2, checkIn: '2027-03-04', checkOut: '2027-03-08' }];
    assert.strictEqual(assignUnits(ROOMS.slice(0, 2), holds, '2027-03-02', '2027-03-06', 1), null);
});

check('rooms are packed tightly: the room freed the morning they arrive is chosen first', () => {
    const got = assignUnits(ROOMS, HOLDS, '2027-03-06', '2027-03-08', 1);
    assert.deepStrictEqual(got?.map((u) => u.id), [2]);
    const two = assignUnits(ROOMS, HOLDS, '2027-03-06', '2027-03-08', 2);
    assert.deepStrictEqual(two?.map((u) => u.id), [2, 1]);
    assert.strictEqual(assignUnits(ROOMS, HOLDS, '2027-03-03', '2027-03-04', 3), null);
    assert.deepStrictEqual(freeUnits(ROOMS, HOLDS, '2027-03-03', '2027-03-04').map((u) => u.id), [3]);
});

check('a calendar counts free rooms per night', () => {
    const m = freeByNight(ROOMS, HOLDS, '2027-03-01', 6);
    assert.deepStrictEqual([...m.values()], [2, 2, 1, 2, 2, 3]);
    assert.strictEqual(canArriveOn(ROOMS, HOLDS, '2027-03-03', 1, 2), false);
    assert.strictEqual(canArriveOn(ROOMS, HOLDS, '2027-03-04', 2, 2), true);
});

console.log('\nstay-clean');

check('a stay type: name required, guests and times checked, money never invented', () => {
    const ok = cleanStayType({ name: '  Seaview Cottage ', stayType: 'whole', maxGuests: '4', checkInTime: '15:00', currency: 'eur', depositPercent: 30, balanceCollection: 'auto', damageDeposit: '150' });
    assert.ok(ok.ok, !ok.ok ? ok.message : '');
    if (ok.ok) {
        assert.strictEqual(ok.value.name, 'Seaview Cottage');
        assert.strictEqual(ok.value.maxGuests, 4);
        assert.strictEqual(ok.value.currency, 'EUR');
        assert.strictEqual(ok.value.balanceCollection, 'auto');
        assert.strictEqual(ok.value.damageDeposit, 15000, 'typed in pounds/euros, stored in minor units');
        assert.strictEqual(ok.value.checkOutTime, '10:00');
    }
    assert.ok(!cleanStayType({ name: '' }).ok);
    assert.ok(!cleanStayType({ name: 'X', maxGuests: 0 }).ok);
    assert.ok(!cleanStayType({ name: 'X', checkInTime: '25:00' }).ok);
    assert.ok(!cleanStayType({ name: 'X', balanceCollection: 'sometimes' }).ok);
    assert.ok(!cleanStayType({ name: 'X', depositPercent: 120 }).ok);
    const amen = cleanStayType({ name: 'X', amenities: ['wifi', 'parking', 'jacuzzi-on-the-moon', 'wifi'] });
    assert.ok(amen.ok && JSON.stringify(amen.value.amenities) === '["wifi","parking"]', 'closed amenity list, no repeats');
});

check('a rate: seasons need both dates; amounts typed as money', () => {
    const r = cleanStayRate({ name: 'Summer', startsOn: '2027-07-01', endsOn: '2027-08-31', nightly: '150', weekendNightly: '', minNights: 7, changeoverDays: ['sat', 'xyz'] });
    assert.ok(r.ok, !r.ok ? r.message : '');
    if (r.ok) {
        assert.strictEqual(r.value.nightly, 15000);
        assert.strictEqual(r.value.weekendNightly, null);
        assert.deepStrictEqual(r.value.changeoverDays, ['sat']);
    }
    assert.ok(!cleanStayRate({ nightly: '100', startsOn: '2027-07-01' }).ok);
    assert.ok(!cleanStayRate({ nightly: '100', startsOn: '2027-08-01', endsOn: '2027-07-01' }).ok);
    assert.ok(!cleanStayRate({ nightly: '' }).ok);
});

check('a fee and a cancellation policy', () => {
    const f = cleanStayFee({ kind: 'cleaning', label: '', amount: '60', per: 'stay' });
    assert.ok(f.ok && f.value.label === 'Cleaning' && f.value.amount === 6000);
    assert.ok(!cleanStayFee({ kind: 'spa', amount: '1' }).ok);
    const c = cleanCancellation([{ days: 14, refund: 50 }, { days: 28, refund: 100 }, { days: 14, refund: 20 }]);
    assert.ok(c.ok && JSON.stringify(c.value) === '[{"days":28,"refund":100},{"days":14,"refund":50}]');
    assert.ok(!cleanCancellation([{ days: -1, refund: 50 }]).ok);
});

check('slugs are safe for a web address', () => {
    assert.strictEqual(slugifyStay('Seaview Cottage — Sleeps 4!'), 'seaview-cottage-sleeps-4');
    assert.strictEqual(slugifyStay('***'), 'stay');
});

console.log('\nwiring');

check('a stay booking re-checks rooms and price under the bookings lock', () => {
    const src = read('src/utils/stays.ts');
    assert.ok(src.includes('pg_advisory_xact_lock(hashtext(${`bookings:${orgId}`}))'), 'same lock as every other booking');
    assert.ok(/quoteStay\(/.test(src) && /assignUnits\(/.test(src), 'price and room worked out again inside the lock');
});

check('the public view of a stay never carries the arrival details', () => {
    const src = read('src/utils/stays.ts');
    const pub = src.slice(src.indexOf('export function publicStay'), src.indexOf('// end publicStay'));
    assert.ok(pub.length > 50, 'publicStay found');
    assert.ok(!pub.includes('arrivalDetails'), 'door codes must never reach a page');
});

check('appointment and table times ignore stay bookings', () => {
    const src = read('src/utils/bookings.ts');
    const takenOn = src.slice(src.indexOf('async function takenOn'), src.indexOf('/** What a booking section'));
    assert.ok(takenOn.includes("ne(bookings.kind, 'stay')"), 'a cottage booking must not block a hair appointment');
});

check('the SQL widens the kind check and every new table is in the data export', () => {
    const sqlText = read('db/z-stays.sql');
    assert.ok(sqlText.includes("'appointment', 'consultation', 'table', 'class', 'stay'"));
    for (const k of ['stayTypes', 'stayRates', 'stayFees', 'stayUnits', 'stayBlocks', 'bookingUnits']) assert.ok((WORKSPACE_TABLES as any)[k], `export misses ${k}`);
});

console.log(`\n${passed}/${total} passed`);
