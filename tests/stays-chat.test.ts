// tests/stays-chat.test.ts — the Website Assistant's chat and holiday lets / B&B rooms
// (docs/holiday-lets-plan.md §6): what the chat is told (stays-prompt.ts), the three cards
// (stay_setup, stay_block, stay_damage) and that each click uses the SAME server action as the GUI.
//
// Run:  npx tsx tests/stays-chat.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stayLine } from '../src/utils/stays-prompt';
import type { LoadedStay } from '../src/utils/stays';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const STAY = {
    row: {
        id: 7, stayType: 'room', name: 'Double with sea view', status: 'active', maxGuests: 2, bedrooms: null, bathrooms: null, beds: '1 double',
        checkInTime: '15:00', checkOutTime: '10:00', mode: 'instant', currency: 'EUR', depositPercent: 25, balanceDays: 28, balanceCollection: 'auto',
        damageDeposit: 15000, damageDepositReturnDays: 7, cancellation: [{ days: 28, refund: 100 }], minNoticeDays: 1, maxAdvanceDays: 365, gapNights: 0,
        images: [{ assetId: 1, alt: 'x' }], amenities: ['wifi', 'sea_view'], houseRules: 'Quiet after 10pm.', licenceNumber: 'AMA-123',
        arrivalDetails: 'Key safe code 4321, Wi-Fi password Bluebird',
    },
    rates: [{ name: 'Standard', startsOn: null, endsOn: null, nightly: 9500, weekendNightly: null, weeklyNightly: null, minNights: 1, changeoverDays: null }],
    fees: [{ id: 1, kind: 'breakfast', label: 'Breakfast', amount: 1200, per: 'guest_night', afterGuests: null, optional: true }],
    units: [{ id: 70, name: 'Room 3' }, { id: 71, name: 'Room 5' }],
} as unknown as LoadedStay;

console.log('\nwhat the chat is told');

check('every id a card needs, the prices in the stay\'s currency, the payment rules', () => {
    const line = stayLine(STAY);
    for (const t of ['stayId 7', 'Room 3 (unitId 70)', 'Room 5 (unitId 71)', '€95/night', 'Breakfast €12 per guest per night (guest chooses)',
        '25% deposit', 'card charged automatically', 'damage deposit €150', 'Licence number: AMA-123']) assert.ok(line.includes(t), `missing ${t}`);
});

check('the door code and Wi-Fi password never reach the prompt — only that they are set', () => {
    const line = stayLine(STAY);
    assert.ok(!line.includes('4321') && !line.includes('Bluebird'));
    assert.ok(line.includes('Arrival details: set (private — never repeat them)'));
    const src = read('src/utils/stays-prompt.ts');
    assert.ok(!/r\.arrivalDetails\s*\}/.test(src) && !src.includes('${r.arrivalDetails}'), 'the arrival details value is never interpolated');
});

check('a stay with no standard price says it is not bookable', () => {
    const line = stayLine({ ...STAY, rates: [] } as LoadedStay);
    assert.ok(line.includes('NONE SET — not bookable'));
});

check('the Website Assistant\'s snapshot carries the stays block', () => {
    assert.ok(read('src/utils/site-store.ts').includes("(await import('./stays-prompt')).staysForPrompt(db, orgId)"));
});

console.log('\nthe prompt');

check('the chat is taught all three cards, with the owner\'s-words-only rules', () => {
    const p = read('netlify/functions/chat-orchestrator.ts');
    for (const t of ['{"type":"stay_setup"', '{"type":"stay_block"', '{"type":"stay_damage"']) assert.ok(p.includes(t), t);
    assert.ok(p.includes('never invent a price, a season, a fee, a bed, an amenity, a rule, a licence number or a description'));
    assert.ok(p.includes('give ONLY the fields that change'));
    assert.ok(p.includes('Never suggest keeping money yourself'));
    assert.ok(p.includes('never repeat saved ones'));
});

console.log('\nthe cards and their clicks');

check('the cards are registered and only dispatch on a click', () => {
    const r = read('src/components/disruptive-ui-registry.js');
    for (const t of ["register('stay_setup', renderStaySetupCard)", "register('stay_block', renderStayBlockCard)", "register('stay_damage', renderStayDamageCard)"]) assert.ok(r.includes(t), t);
    const card = r.slice(r.indexOf('function stayCard('), r.indexOf("register('stay_setup'"));
    assert.ok(card.indexOf("closest('[data-st-go]')") < card.indexOf('el.dispatchEvent('), 'nothing is sent before the button');
    assert.ok(r.includes("eventName: 'site:staySetup'") && r.includes("eventName: 'site:stayBlock'") && r.includes("eventName: 'site:stayDamage'"));
});

check('each click calls the same server action as the GUI', () => {
    const c = read('src/components/chat-session.js');
    assert.ok(c.includes("staysCall('PUT', { ...stay, id: d.stayId, partial: true })") && c.includes("staysCall('POST', stay)"), 'Stays tab API, a change named partially');
    assert.ok(c.includes("staysCall('POST', { block: b })"), 'the Stays tab\'s closed dates');
    assert.ok(c.includes("action: 'damage_keep', assistantId, id: d.bookingId, keep: d.keep, reason: d.reason") && c.includes("action: 'damage_return', assistantId, id: d.bookingId"), 'the Bookings tab\'s buttons');
    for (const e of ['site:staySetup', 'site:stayBlock', 'site:stayDamage']) {
        assert.ok(c.includes(`container.addEventListener('${e}'`) && c.includes(`container.removeEventListener('${e}'`), e);
    }
});

check('a partial change is laid over what is saved, then through the same checks', () => {
    const fn = read('netlify/functions/stays.ts');
    const at = fn.indexOf('if (method === \'PUT\' && body.partial === true)');
    assert.ok(at > 0 && at < fn.indexOf('const stay = cleanStayType(body);'), 'merged BEFORE the checks');
    assert.ok(fn.includes('body = { ...inputFromView(current), ...changes, id };'));
    // The merge keeps the saved door code: the chat can't see it, so it must not wipe it.
    assert.ok(fn.includes('arrivalDetails: v.arrivalDetails'));
});

console.log(`\n${passed}/${total} passed`);
