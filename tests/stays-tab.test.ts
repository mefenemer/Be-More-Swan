// tests/stays-tab.test.ts — Business Information ▸ Stays (docs/holiday-lets-plan.md §6): the owner's tab
// (stays-editor.js), its API (netlify/functions/stays.ts), the "stays" offer tick, and the website
// editor's Stays section. What the editor sends must pass the server's own checks (stay-clean.ts).
//
// Run:  npx tsx tests/stays-tab.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanCancellation, cleanStayFee, cleanStayRate, cleanStayType } from '../src/utils/stay-clean';
import { OFFER_KINDS, OFFER_LABELS, inferOffers } from '../src/utils/offer-profile';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// Exactly what stays-editor.js payload() sends for a B&B room type (inputs are strings, as typed).
const SENT = {
    stayType: 'room', name: 'Double with sea view', summary: '', description: '', maxGuests: '2', bedrooms: '', bathrooms: '', beds: '1 double',
    address: '', licenceNumber: '', checkInTime: '15:00', checkOutTime: '10:30', breakfast: 'optional', mode: 'instant',
    amenities: ['wifi', 'sea_view'], images: [{ assetId: 2, alt: 'The bay window' }], currency: 'EUR', singleDiscount: '15',
    rates: [
        { name: 'Standard', startsOn: null, endsOn: null, nightly: '95', weekendNightly: '', weeklyNightly: '', minNights: '1', changeoverDays: [] },
        { name: 'Summer', startsOn: '2027-07-01', endsOn: '2027-08-31', nightly: '130.50', weekendNightly: '', weeklyNightly: '', minNights: '2', changeoverDays: ['sat'] },
    ],
    fees: [{ kind: 'breakfast', label: '', amount: '12', per: 'guest_night', afterGuests: '' }],
    depositPercent: '0', balanceDays: '28', balanceCollection: 'link', damageDeposit: '', damageDepositReturnDays: '7',
    cancellation: [{ days: 28, refund: 100 }, { days: 14, refund: 50 }], minNoticeDays: '0', maxAdvanceDays: '365', gapNights: '0',
    houseRules: 'Quiet after 10pm.', arrivalDetails: 'Key safe 1234', arrivalDetailsDays: '2', rooms: ['Room 3', 'Room 5'],
};

console.log('\nwhat the editor sends');

check('the editor\'s save passes the server\'s checks, money typed in euros stored in cents', () => {
    const t = cleanStayType(SENT);
    assert.ok(t.ok, !t.ok ? t.message : '');
    if (t.ok) {
        assert.strictEqual(t.value.currency, 'EUR');
        assert.strictEqual(t.value.singleDiscount, 1500);
        assert.strictEqual(t.value.damageDeposit, null, 'left empty = no damage deposit, never zero');
        assert.strictEqual(t.value.maxGuests, 2);
        assert.strictEqual(t.value.arrivalDetails, 'Key safe 1234');
    }
    const rates = SENT.rates.map((r) => cleanStayRate(r as unknown as Record<string, unknown>));
    assert.ok(rates.every((r) => r.ok));
    if (rates[1].ok) assert.deepStrictEqual([rates[1].value.nightly, rates[1].value.minNights, rates[1].value.changeoverDays], [13050, 2, ['sat']]);
    const fee = cleanStayFee(SENT.fees[0]);
    assert.ok(fee.ok && fee.value.label === 'Breakfast' && fee.value.optional && fee.value.per === 'guest_night');
    assert.ok(cleanCancellation(SENT.cancellation).ok);
});

check('the editor sends the payload keys the API reads, and rooms only for a room type', () => {
    const js = read('src/components/stays-editor.js');
    const fn = js.slice(js.indexOf('function payload('), js.indexOf('function replaceStay('));
    for (const k of Object.keys(SENT)) assert.ok(fn.includes(k), `payload misses ${k}`);
    assert.ok(fn.includes("...(f.stayType === 'room' ? { rooms: f.rooms } : {})"));
    assert.ok(fn.includes('images: f.images.map((im) => ({ assetId: im.assetId, alt: im.alt }))'), 'only id and alt are sent, never a signed link');
});

console.log('\nthe API');

check('tenant-scoped, viewers read only, and a stay with guests to come is never deleted', () => {
    const fn = read('netlify/functions/stays.ts');
    assert.ok(fn.includes('const ctx = await requireTenant(event, db);'));
    assert.ok(fn.includes("if (method !== 'GET' && ctx.role === 'viewer')"));
    assert.ok(fn.indexOf('hasGuestsToCome(db, orgId, id, today)') < fn.indexOf('db.delete(stayTypes)'));
    assert.ok(fn.includes('eq(stayTypes.organisationId, orgId)'));
    // Every write goes through the same checks the chat card will use.
    for (const c of ['cleanStayType(body)', 'cleanCancellation(body.cancellation)', 'cleanStayRate(', 'cleanStayFee(']) assert.ok(fn.includes(c), c);
});

check('closed dates: real dates, this workspace\'s room, never over a guest\'s nights', () => {
    const fn = read('netlify/functions/stays.ts');
    const block = fn.slice(fn.indexOf("if (method === 'POST' && body.block"), fn.indexOf("if (method === 'PATCH')"));
    assert.ok(block.includes('DATE_RE.test(startsOn)') && block.includes('endsOn <= startsOn'));
    assert.ok(block.includes('eq(stayUnits.organisationId, orgId)'));
    assert.ok(block.includes('lt(bookingUnits.checkIn, endsOn), gt(bookingUnits.checkOut, startsOn), holdsTime'));
});

check('a database without the SQL answers "not switched on yet", not a crash', () => {
    assert.ok(read('netlify/functions/stays.ts').includes('return json(503'));
});

console.log('\nthe tab');

check('Business Information has a Stays tab, shown by the "stays" tick, loading the editor', () => {
    const html = read('assets.html');
    assert.ok(html.includes('data-tab="stays"') && html.includes('data-panel="stays"'));
    assert.ok(html.includes('<section id="stays-root"') && html.includes('src="/src/components/stays-editor.js'));
    assert.ok(html.includes("tab('stays')?.classList.toggle('hidden', !o.offers.includes('stays'))"));
    assert.ok(html.includes('data-op-offer value="stays"'));
});

check('arrival details are labelled private in the editor', () => {
    const js = read('src/components/stays-editor.js');
    assert.ok(js.includes("'Arrival details (private)'") && js.includes('Never shown on your website'));
});

check('every input in the editor sits inside its label', () => {
    const js = read('src/components/stays-editor.js');
    assert.ok(!/<div><label class="\$\{label\}">/.test(js), 'a label is not wrapped around its input');
});

console.log('\nthe offer tick and the website editor');

check('"stays" is the seventh offer, guessed from holiday-let words, a site feature or stays already set up', () => {
    assert.ok((OFFER_KINDS as readonly string[]).includes('stays'));
    assert.ok(OFFER_LABELS.stays.includes('holiday lets'));
    assert.deepStrictEqual(inferOffers({ industry: 'Self-catering cottages' }), ['stays']);
    const card = read('src/components/disruptive-ui-registry.js');
    assert.ok(card.includes("stays: 'Guests stay with us"), 'the chat card names it too');
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"stays" (holiday lets, B&B or guest house rooms booked by the night — the Stays tab)'));
});

check('the website editor offers a Stays section that points to Business Information', () => {
    const js = read('src/components/assistant-site-editor.js');
    assert.ok(js.includes("stays: 'Stays (holiday lets, rooms)'"));
    assert.ok(js.includes("stays: { heading: 'Stay with us', intro: '', stayIds: [], buttonLabel: 'See dates and prices' }"));
    assert.ok(js.includes("f.kind === 'staysInfo'") && js.includes('/workspace.html?view=assets&amp;tab=stays'));
});

console.log(`\n${passed}/${total} passed`);
