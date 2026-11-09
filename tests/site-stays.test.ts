// tests/site-stays.test.ts — holiday lets and B&B rooms on a customer's site (docs/holiday-lets-plan.md §4–5):
// the stays section, each stay's own page and calendar, the booking steps' links, and the money for a stay.
//
// Run:  npx tsx tests/site-stays.test.ts

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-stays';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normaliseSiteDefinition, RESERVED_SLUGS, SITE_FEATURES } from '../src/utils/site-definition';
import { renderSitePage, renderSiteStay, renderSitemap, type RenderContext } from '../src/utils/site-render';
import { calendarMonths, stayRoute, staysFor, type SiteRenderStay, type SiteRenderStays, type StayPageView } from '../src/utils/site-stays';
import { readStayChoice, stayLink } from '../src/utils/site-stay-booking';
import { chargeNow, stayCheckoutParams, stayRefundFor } from '../src/utils/stay-charges';
import { quoteStay, type StayPricing } from '../src/utils/stay-quote';
import { describeBooking, type BookingRow } from '../src/utils/bookings';
import { depositNote } from '../src/utils/booking-deposits';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const PRICING: StayPricing = {
    currency: 'GBP', maxGuests: 4, singleDiscount: null,
    rates: [{ name: 'Standard', startsOn: null, endsOn: null, nightly: 12000, weekendNightly: null, weeklyNightly: 9500, minNights: 2, changeoverDays: null }],
    fees: [{ id: 1, kind: 'cleaning', label: 'Cleaning', amount: 6000, per: 'stay', afterGuests: null, optional: false }],
    depositPercent: 25, balanceDays: 28, balanceCollection: 'auto', damageDeposit: 15000,
    cancellation: [{ days: 28, refund: 100 }, { days: 14, refund: 50 }],
};
const COTTAGE: SiteRenderStay = {
    id: 7, stayType: 'whole', name: 'Seaview Cottage', slug: 'seaview-cottage', summary: 'A stone cottage above the harbour.', description: 'Two bedrooms.\n\nA garden with a view.',
    maxGuests: 4, bedrooms: 2, bathrooms: 1, beds: '1 king, 2 singles', amenities: ['wifi', 'parking', 'sea_view'], houseRules: 'No parties.', address: 'Harbour Lane, St Ives',
    licenceNumber: 'STL-123', images: [{ assetId: 55, alt: 'The cottage from the lane' }], checkInTime: '16:00', checkOutTime: '10:00', mode: 'request', breakfast: 'none',
    units: 1, pricing: PRICING, limits: { minNoticeDays: 1, maxAdvanceDays: 540 }, gapNights: 0, fromPrice: 'From £95 a night',
};
const ROOM: SiteRenderStay = { ...COTTAGE, id: 8, stayType: 'room', name: 'Double with sea view', slug: 'double-sea-view', bedrooms: null, bathrooms: null, beds: '1 double', breakfast: 'included', units: 3, fromPrice: 'From £80 a night' };
const DATA: SiteRenderStays = { stays: [COTTAGE, ROOM] };
const SITE = normaliseSiteDefinition({
    settings: { siteName: 'Harbour Stays', features: ['stays'] },
    pages: [
        { id: 'home', slug: '', title: 'Home', sections: [
            { id: 'hero', type: 'hero', props: { headline: 'Stay by the sea' } },
            { id: 'st', type: 'stays', props: { heading: 'Where you can stay' } },
        ] },
        { id: 'rooms', slug: 'rooms', title: 'Rooms', sections: [{ id: 'r', type: 'stays', props: { stayIds: [8, 999, 8], buttonLabel: 'Book a room' } }] },
    ],
}).definition;
const ctx = (o: Partial<RenderContext> = {}): RenderContext => ({ origin: 'https://harbour.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, stays: DATA, assetUrl: (id) => `https://cdn.test/${id}.jpg`, ...o });

console.log('\nsection');

check('a real section type behind its own feature; /stays is reserved; the section holds ids only', () => {
    assert.ok((SITE_FEATURES as readonly string[]).includes('stays'));
    assert.ok(RESERVED_SLUGS.has('stays'));
    const s = SITE.pages[1].sections[0];
    assert.strictEqual(s.type, 'stays');
    if (s.type !== 'stays') return;
    assert.deepStrictEqual(s.props, { heading: 'Stay with us', intro: null, stayIds: [8, 999], buttonLabel: 'Book a room' });
    const d = normaliseSiteDefinition({ pages: [{ title: 'Stays', slug: 'stays', sections: [{ type: 'text', props: { body: 'x' } }] }] }).definition;
    assert.notStrictEqual(d.pages[0].slug, 'stays', 'a page may not take /stays');
});

check('cards: every active stay by default, the chosen ones in order otherwise, unknown ids dropped', () => {
    assert.deepStrictEqual(staysFor(DATA, []).map((s) => s.id), [7, 8]);
    assert.deepStrictEqual(staysFor(DATA, [8, 999]).map((s) => s.id), [8]);
    assert.deepStrictEqual(staysFor(null, []), []);
    const html = renderSitePage(SITE, '/', ctx()).html;
    assert.ok(html.includes('href="/stays/seaview-cottage"'));
    assert.ok(html.includes('From £95 a night'));
    assert.ok(html.includes('Sleeps 4 · 2 bedrooms · 1 bathroom'));
    assert.ok(html.includes('Sleeps 4 per room'), 'a room type says per room');
    assert.ok(html.includes('https://cdn.test/55.jpg'));
});

check('no stays yet: a note in the preview only, nothing on the live site', () => {
    assert.ok(!renderSitePage(SITE, '/', ctx({ stays: { stays: [] } })).html.includes('id="st"'));
    assert.ok(renderSitePage(SITE, '/', ctx({ stays: { stays: [] }, preview: true })).html.includes('Business Information ▸ Stays'));
});

console.log('\nstay page');

const VIEW: StayPageView = {
    stay: COTTAGE, today: '2026-11-09', prevMonth: null, nextMonth: '2026-12',
    months: calendarMonths('2026-11', 2, new Map([['2026-11-20', 1], ['2026-11-21', 0], ['2026-11-22', 1]]), '2026-11-09', '2028-05-02'),
};

check('the calendar: Monday-first, past days muted, booked nights struck, free nights link to booking from that day', () => {
    const nov = VIEW.months[0];
    assert.strictEqual(nov.label, 'November 2026');
    assert.strictEqual(nov.days.findIndex((d) => d !== null), 6, '1 Nov 2026 is a Sunday');
    const html = renderSiteStay(SITE, ctx(), VIEW, '/_book');
    assert.ok(html.includes('href="/_book?stay=7&amp;in=2026-11-20"'), 'a free night links to the booking step');
    assert.ok(/class="gone"[^>]*>21</.test(html), 'a booked night is struck through');
    assert.ok(/class="past">8</.test(html), 'a past day is muted');
    assert.ok(html.includes('/stays/seaview-cottage?month=2026-12'), 'later months reachable');
});

check('the page: facts, amenities, rules, cancellation, licence number, search data — and never arrival details', () => {
    const html = renderSiteStay(SITE, ctx(), VIEW, '/_book');
    assert.strictEqual((html.match(/<h1>/g) || []).length, 1);
    for (const t of ['Seaview Cottage', 'Wi-Fi', 'Sea view', 'No parties.', 'Licence / registration number: STL-123', 'Check-in from 4pm · check-out by 10am',
        'Full refund if you cancel 28+ days before arrival', 'alt="The cottage from the lane"']) assert.ok(html.includes(t), `missing ${t}`);
    assert.ok(html.includes('"@type":"VacationRental"'));
    assert.ok(html.includes('<link rel="canonical" href="https://harbour.bemoreswan.site/stays/seaview-cottage">'));
    assert.ok(!('arrivalDetails' in COTTAGE), 'the public view has no arrival details at all');
    const room = renderSiteStay(SITE, ctx(), { ...VIEW, stay: ROOM }, '/_book');
    assert.ok(room.includes('"@type":"HotelRoom"') && room.includes('"@type":"BedAndBreakfast"'));
    assert.ok(room.includes('name="rooms"'), 'a room type lets them choose how many rooms');
    assert.ok(!html.includes('name="rooms"'), 'a whole property does not');
});

check('routes and the sitemap', () => {
    assert.deepStrictEqual(stayRoute('/stays/seaview-cottage'), { slug: 'seaview-cottage' });
    assert.deepStrictEqual(stayRoute('/stays/seaview-cottage/?month=2026-12'), { slug: 'seaview-cottage' });
    assert.strictEqual(stayRoute('/stays/'), null);
    assert.strictEqual(stayRoute('/stays/../admin'), null);
    assert.ok(renderSitemap(SITE, 'https://h.test', [], [], ['seaview-cottage']).includes('<loc>https://h.test/stays/seaview-cottage</loc>'));
});

console.log('\nbooking steps');

check('choices from the query: only real dates, numbers in range, extras as ids', () => {
    const c = readStayChoice(new URLSearchParams('stay=7&in=2027-03-05&out=nope&guests=3&rooms=0&x=1,2,abc&x=2'));
    assert.deepStrictEqual(c, { stay: 7, in: '2027-03-05', out: null, guests: 3, rooms: 1, extras: [1, 2] });
    assert.strictEqual(stayLink({ ...c, out: '2027-03-08', rooms: 2 }), '/_book?stay=7&in=2027-03-05&out=2027-03-08&guests=3&rooms=2&x=1%2C2');
});

console.log('\nmoney');

const quoted = quoteStay(PRICING, { checkIn: '2027-03-05', checkOut: '2027-03-08', guests: 2, rooms: 1, extras: [], today: '2026-11-09' }, { minNoticeDays: 1, maxAdvanceDays: 540 });
assert.ok(quoted.ok);
const Q = quoted.ok ? quoted.quote : (null as never);

check('Checkout: the stay\'s currency; a deposit line; the card saved only when the owner chose automatic balance', () => {
    const p = stayCheckoutParams({ origin: 'https://h.test', booking: { id: 3, organisationId: 9, siteId: 2, customerEmail: 'g@x.test', stayTypeId: 7 }, quote: { ...Q, currency: 'EUR' }, what: 'Seaview', when: 'Fri', backPath: '/stays/seaview-cottage', now: new Date('2026-11-09T10:00:00Z') });
    assert.strictEqual(p.line_items!.length, 1, 'damage deposit goes with the balance here');
    assert.strictEqual(p.line_items![0].price_data!.currency, 'eur');
    assert.strictEqual(p.line_items![0].price_data!.unit_amount, Q.dueNow);
    assert.ok(String(p.line_items![0].price_data!.product_data!.name).startsWith('Deposit'));
    assert.strictEqual(p.payment_intent_data!.setup_future_usage, 'off_session');
    assert.strictEqual(p.metadata!.bms_kind, 'booking_deposit', 'rides the deposit webhook and hold');
    assert.strictEqual(p.metadata!.bms_stay, '7');
    assert.ok(String(p.cancel_url).includes('release=3'));
    const link = stayCheckoutParams({ origin: 'https://h.test', booking: { id: 3, organisationId: 9, siteId: 2, customerEmail: 'g@x.test', stayTypeId: 7 }, quote: { ...Q, balanceCollection: 'link' }, what: 'S', when: 'W', backPath: '/', now: new Date() });
    assert.strictEqual(link.payment_intent_data!.setup_future_usage, undefined, 'a pay-link balance never saves the card');
});

check('paid in full at booking: one payment with the damage deposit as its own line', () => {
    const full = { ...Q, dueNow: Q.total, balance: 0, balanceDueOn: null, balanceCollection: null, damageDepositNow: true };
    assert.deepStrictEqual(chargeNow(full), { stay: Q.total, damage: 15000, total: Q.total + 15000 });
    const p = stayCheckoutParams({ origin: 'https://h.test', booking: { id: 4, organisationId: 9, siteId: 2, customerEmail: 'g@x.test', stayTypeId: 7 }, quote: full, what: 'S', when: 'W', backPath: '/', now: new Date() });
    assert.strictEqual(p.line_items!.length, 2);
    assert.strictEqual(p.line_items![1].price_data!.product_data!.name, 'Refundable damage deposit');
    assert.strictEqual(p.metadata!.bms_damage_now, '1');
    assert.strictEqual(p.payment_intent_data!.setup_future_usage, undefined);
});

check('a guest cancelling gets the policy\'s share of what they paid, and all of a damage deposit we hold', () => {
    const b = { checkIn: '2027-03-05', depositPence: 10000, paymentStatus: 'paid', damageDepositPence: 15000, damageDepositStatus: 'due', balanceStatus: 'due', balancePence: 30000 };
    assert.deepStrictEqual(stayRefundFor(b, PRICING.cancellation, '2027-01-01'), { percent: 100, stay: 10000, damage: 0, total: 10000 });
    assert.deepStrictEqual(stayRefundFor(b, PRICING.cancellation, '2027-02-15'), { percent: 50, stay: 5000, damage: 0, total: 5000 });
    assert.deepStrictEqual(stayRefundFor(b, PRICING.cancellation, '2027-03-01'), { percent: 0, stay: 0, damage: 0, total: 0 });
    assert.deepStrictEqual(stayRefundFor({ ...b, damageDepositStatus: 'held', balanceStatus: 'none' }, PRICING.cancellation, '2027-03-01'), { percent: 0, stay: 0, damage: 15000, total: 15000 });
    assert.strictEqual(stayRefundFor({ ...b, paymentStatus: null }, PRICING.cancellation, '2027-01-01').total, 0, 'nothing paid, nothing back');
    // Balance paid too: the policy's share of BOTH payments.
    assert.deepStrictEqual(stayRefundFor({ ...b, balanceStatus: 'paid', damageDepositStatus: 'held' }, PRICING.cancellation, '2027-02-15'), { percent: 50, stay: 20000, damage: 15000, total: 35000 });
});

check('emails describe a stay by dates and nights, in the stay\'s currency', () => {
    const row = { kind: 'stay', checkIn: '2027-03-05', checkOut: '2027-03-08', rooms: 2, partySize: 4, serviceName: 'Double with sea view', startsAt: new Date(), endsAt: new Date() } as unknown as BookingRow;
    assert.deepStrictEqual(describeBooking(row, 'Europe/London'), { what: 'Double with sea view (2 rooms, 4 guests)', when: 'Friday 5 March to Monday 8 March (3 nights)' });
    assert.strictEqual(depositNote({ depositPence: 9000, paymentStatus: 'paid', currency: 'EUR', kind: 'stay', balancePence: 27000 }), '€90 deposit paid');
    assert.strictEqual(depositNote({ depositPence: 9000, paymentStatus: 'paid', currency: 'EUR', kind: 'stay', balancePence: 0 }), '€90 payment paid');
    assert.strictEqual(depositNote({ depositPence: 2000, paymentStatus: 'paid' }), '£20 deposit paid', 'appointments unchanged');
});

console.log('\nwiring');

check('the live site and the preview serve /stays/<slug>; the booking steps hand stays to their own module', () => {
    const serve = read('netlify/functions/site-serve.ts');
    assert.ok(serve.includes('stayRoute(path)') && serve.includes('renderSiteStay(definition, ctx, v, BOOK_PATH)'));
    assert.ok(serve.includes('stays: await loadSiteStays('));
    const preview = read('netlify/functions/site-preview.ts');
    assert.ok(preview.includes('stayRoute(path)') && preview.includes('stays: await loadSiteStays('));
    const booking = read('src/utils/site-booking.ts');
    assert.ok(booking.includes("if (q.get('stay')) return (await import('./site-stay-booking')).stayStep"));
    assert.ok(booking.includes("if (body.get('stay')) return (await import('./site-stay-booking')).stayBookSubmit"));
    assert.ok(booking.includes("if (row.kind === 'stay') return (await import('./site-stay-booking')).stayCancelSubmit"), 'a stay never takes the full-deposit refund path');
    assert.ok(booking.includes("if (row.kind === 'stay') return (await import('./site-stay-booking')).stayManagePage"));
});

check('the webhook confirms a stay by the stay\'s own setting and records the saved card and damage deposit', () => {
    const wh = read('netlify/functions/stripe-connect-webhook.ts');
    assert.ok(wh.includes('stayModeFor(db, stayId)') && wh.includes('stayPaymentSettled(db, r.booking, session)'));
});

check('the renderer stays pure: site-stays.ts imports no database code', () => {
    const src = read('src/utils/site-stays.ts');
    assert.ok(!/from '\.\.\/\.\.\/db\//.test(src) && !/from '\.\/stays'/.test(src.replace("import type { PublicStay } from './stays';", '')));
});

console.log(`\n${passed}/${total} passed`);
