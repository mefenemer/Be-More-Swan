// tests/site-calendar-enquiries.test.ts
// From live testing (owner, 2026-10-17): the Website Assistant's Calendar shows availability and
// bookings together (n of N, n booked · n free, open a booking to decide it); enquirers join the
// Audience only with their agreement; "Timetable" is "Availability"; the Website tab leads with what a
// new site needs, and the layout lives in Design.
//
// Run:  npx tsx tests/site-calendar-enquiries.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanRange, MAX_CALENDAR_DAYS } from '../src/utils/booking-calendar';
import { splitName } from '../src/utils/enquiry-audience';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nThe Calendar tab');

check('a month at a time, never more', () => {
    assert.deepStrictEqual(cleanRange('2026-09-28', '2026-11-08'), { from: '2026-09-28', to: '2026-11-08' });
    assert.strictEqual(MAX_CALENDAR_DAYS, 42);
    assert.strictEqual(cleanRange('2026-01-01', '2026-03-01'), null);
    assert.strictEqual(cleanRange('2026-02-01', '2026-01-01'), null);
    assert.strictEqual(cleanRange('x', '2026-01-01'), null);
});
check('hours, free times, classes n of N, bookings — decided through the same path as the Bookings tab', () => {
    const c = read('src/utils/booking-calendar.ts');
    assert.ok(c.includes('await slotsForDay(db, orgId, setup,') && c.includes("filter((b) => b.paymentStatus !== 'expired')"));
    const ui = read('src/components/site-booking-calendar.js');
    assert.ok(ui.includes('${esc(s.taken)} of ${esc(s.capacity)}') && ui.includes('Fully booked') && ui.includes('booked · ${day.free} free'));
    assert.ok(ui.includes("post({ action: 'booking_decide', assistantId: cal.assistantId, id: b.id, decision })"));
    assert.ok(read('netlify/functions/sites.ts').includes("if (action === 'calendar') {"));
    assert.ok(read('src/components/assistant-calendar.js').includes("if (state.roleKey === 'website_assistant' && window.SiteBookingCalendar) {"));
    assert.ok(read('workspace.html').includes('<script src="/src/components/site-booking-calendar.js"></script>'));
});

console.log('\nEnquiries and the Audience');

check('the contact form offers an unticked box; ticked, they join with that tick as consent', () => {
    const def = normaliseSiteDefinition({ settings: { siteName: 'B' }, pages: [{ title: 'Home', slug: '', sections: [{ type: 'contact', props: {} }] }] }).definition;
    const html = renderSitePage(def, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null }).html;
    assert.ok(html.includes('<input type="checkbox" name="_updates" value="yes"> Send me news and offers by email.'), 'offered, unticked');
    const off = normaliseSiteDefinition({ settings: { siteName: 'B' }, pages: [{ title: 'Home', slug: '', sections: [{ type: 'contact', props: { offerUpdates: false } }] }] }).definition;
    assert.ok(!renderSitePage(off, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null }).html.includes('name="_updates"'));
    const forms = read('src/utils/site-forms.ts');
    assert.ok(forms.includes("if (section.props.offerUpdates && req.body.get('_updates') === 'yes') {") && forms.includes("by: 'form'"));
    const w = read('src/utils/enquiry-audience.ts');
    assert.ok(w.includes("consentBasis: fromForm ? 'single_opt_in' : 'manual_entry'") && w.includes('await recordConsentEvent(db, {'));
});
check('the owner adds someone only by saying they agreed; a refusal is never lifted', () => {
    const api = read('netlify/functions/sites.ts');
    assert.ok(api.includes("if (body.agreed !== true) return json(400, { error: 'Only add someone who has agreed to receive your emails.' });"));
    assert.ok(api.includes('someone who said stop is never re-subscribed'));
    assert.deepStrictEqual(splitName('  Ana  de la Cruz '), { firstName: 'Ana', lastName: 'de la Cruz' });
});

console.log('\nWords and order');

check('"Availability", not "Timetable"; the Website tab leads with a new site\'s first steps; layout in Design', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('<p class="text-sm font-black text-gray-900">Availability</p>') && !ed.includes('Timetable — classes'));
    const r = ed.slice(ed.indexOf("${featuresOn() ? '' : featuresCard(true)}"));
    assert.ok(r.indexOf('${publishCard()}') > 0, 'what the website does comes before Publish');
    assert.ok(ed.includes('return structureCard() + designCard();'));
    const pages = ed.slice(ed.indexOf('  function pagesPanel() {'), ed.indexOf('  // ── "Add your own words"'));
    assert.ok(!pages.includes('structureCard()') && pages.indexOf('Sections on ${esc(p.title)}') < pages.indexOf('Page details'));
});

console.log(`\n${passed}/${total} passed\n`);
