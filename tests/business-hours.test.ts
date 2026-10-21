// tests/business-hours.test.ts
// The website's "Opening hours & contact" section: the Open-now badge in the business's timezone,
// the week's hours, closed days, one-tap contact buttons, and the search data — all read from
// Business Information (business-hours.ts, booking-settings.ts) and drawn by site-render.ts.
//
// Run:  npx tsx tests/business-hours.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { directionsUrl, openingHoursSpecification, openStatus, upcomingClosures, weekRows, whatsappUrl } from '../src/utils/business-hours';
import { cleanBookingSettings, settingsFromRow } from '../src/utils/booking-settings';
import { normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage, type SiteRenderBusiness } from '../src/utils/site-render';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

// Mon–Fri 9–5, Saturday lunch and evening, closed Sunday. London.
const HOURS = {
    mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }], wed: [{ start: '09:00', end: '17:00' }],
    thu: [{ start: '09:00', end: '17:00' }], fri: [{ start: '09:00', end: '17:00' }],
    sat: [{ start: '10:00', end: '13:00' }, { start: '18:00', end: '22:00' }],
};
const TZ = 'Europe/London';
// 2026-10-14 is a Wednesday; in October London is UTC+1.
const at = (iso: string) => new Date(iso);

console.log('\nOpen now');

check('open inside the hours, with the closing time', () => {
    assert.deepStrictEqual(openStatus(HOURS, [], TZ, at('2026-10-14T10:00:00Z')), { open: true, text: 'Open now · closes 5pm' });
});
check('the business\'s own clock, not UTC: 08:30 UTC is 09:30 in London in October', () => {
    assert.strictEqual(openStatus(HOURS, [], TZ, at('2026-10-14T08:30:00Z'))!.open, true);
    assert.strictEqual(openStatus(HOURS, [], TZ, at('2026-12-16T08:30:00Z'))!.open, false);   // GMT in December
});
check('before opening today, between two periods, after closing, and over the weekend', () => {
    assert.strictEqual(openStatus(HOURS, [], TZ, at('2026-10-14T06:00:00Z'))!.text, 'Closed · opens 9am');
    assert.strictEqual(openStatus(HOURS, [], TZ, at('2026-10-17T14:00:00Z'))!.text, 'Closed · opens 6pm');           // Sat 3pm
    assert.strictEqual(openStatus(HOURS, [], TZ, at('2026-10-14T18:00:00Z'))!.text, 'Closed · opens tomorrow at 9am');
    assert.strictEqual(openStatus(HOURS, [], TZ, at('2026-10-16T18:00:00Z'))!.text, 'Closed · opens tomorrow at 10am');  // Fri evening
    assert.strictEqual(openStatus(HOURS, [], TZ, at('2026-10-17T22:00:00Z'))!.text, 'Closed · opens Monday at 9am'); // Sat 11pm
});
check('a closed day overrides the hours, and the next opening skips it', () => {
    const closures = [{ date: '2026-10-14' }, { date: '2026-10-15' }];
    assert.deepStrictEqual(openStatus(HOURS, closures, TZ, at('2026-10-14T10:00:00Z')), { open: false, text: 'Closed · opens Friday at 9am' });
});
check('no hours at all → nothing to say', () => {
    assert.strictEqual(openStatus({}, [], TZ, at('2026-10-14T10:00:00Z')), null);
});

console.log('\nThe week, closures, links, search data');

check('the week runs Monday first, marks today, and shows two periods', () => {
    const rows = weekRows(HOURS, TZ, at('2026-10-17T10:00:00Z'));
    assert.deepStrictEqual(rows.map((r) => r.day), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    assert.strictEqual(rows[5].text, '10am–1pm, 6pm–10pm');
    assert.strictEqual(rows[6].text, 'Closed');
    assert.deepStrictEqual(rows.filter((r) => r.today).map((r) => r.day), ['Saturday']);
});
check('only closed days in the next three weeks are mentioned', () => {
    const c = upcomingClosures([{ date: '2026-10-01' }, { date: '2026-10-20', note: 'Staff training' }, { date: '2026-12-25' }], TZ, at('2026-10-14T10:00:00Z'));
    assert.deepStrictEqual(c, [{ date: '2026-10-20', note: 'Staff training' }]);
});
check('WhatsApp numbers become international digits; nonsense gives no button', () => {
    assert.strictEqual(whatsappUrl('07700 900123'), 'https://wa.me/447700900123');
    assert.strictEqual(whatsappUrl('+44 (0)7700-900123'.replace('(0)', '')), 'https://wa.me/447700900123');
    assert.strictEqual(whatsappUrl('0033 6 12 34 56 78'), 'https://wa.me/33612345678');
    assert.strictEqual(whatsappUrl('123'), null);
});
check('directions are a Google Maps link to the address on one line', () => {
    assert.strictEqual(directionsUrl('12 High Street\nLeeds\nLS1 4AB'), 'https://www.google.com/maps/dir/?api=1&destination=12%20High%20Street%2C%20Leeds%2C%20LS1%204AB');
});
check('schema.org hours: one entry per opening period', () => {
    const spec = openingHoursSpecification(HOURS);
    assert.strictEqual(spec.length, 7);
    assert.deepStrictEqual(spec[6], { '@type': 'OpeningHoursSpecification', dayOfWeek: 'https://schema.org/Saturday', opens: '18:00', closes: '22:00' });
});

console.log('\nBusiness Information');

check('the address is tidied to lines; a bad WhatsApp number is refused in words', () => {
    const r = cleanBookingSettings({ visitAddress: '  12  High Street \r\n\r\nLeeds\nLS1 4AB ', whatsapp: '+44 7700 900123' });
    assert.ok(r.ok);
    if (r.ok) assert.deepStrictEqual(r.value, { visitAddress: '12 High Street\nLeeds\nLS1 4AB', whatsapp: '+44 7700 900123' });
    const bad = cleanBookingSettings({ whatsapp: 'call me' });
    assert.ok(!bad.ok && /WhatsApp number/.test(bad.error));
    const cleared = cleanBookingSettings({ visitAddress: '   ', whatsapp: '' });
    assert.ok(cleared.ok && cleared.value.visitAddress === null && cleared.value.whatsapp === null);
});
check('a stored row reads back the location (and empty strings as none)', () => {
    const s = settingsFromRow({ visitAddress: '1 Mill Lane', whatsapp: '' });
    assert.strictEqual(s.visitAddress, '1 Mill Lane');
    assert.strictEqual(s.whatsapp, null);
});

console.log('\nThe section on the site');

const site = (props: Record<string, unknown> = {}, settings: Record<string, unknown> = { phone: '0113 496 0000', email: 'hello@example.com' }): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee', locality: 'Leeds', ...settings },
    pages: [{ title: 'Home', slug: '', sections: [{ id: 'hr1', type: 'hours', props }] }],
}).definition;
const business: SiteRenderBusiness = { timezone: TZ, weeklyHours: HOURS, closures: [{ date: '2026-10-20', note: 'Staff training' }], visitAddress: '12 High Street\nLeeds\nLS1 4AB', whatsapp: '07700 900123' };
const live = { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, business, now: at('2026-10-14T10:00:00Z') };

check('the gate keeps the section with every part on and a default heading', () => {
    const d = site();
    const s = d.pages[0].sections[0];
    assert.strictEqual(s.type, 'hours');
    assert.deepStrictEqual(s.props, { heading: 'Opening hours', intro: null, showHours: true, showContact: true, showAddress: true });
    const off = site({ showContact: false }).pages[0].sections[0];
    assert.strictEqual((off.props as { showContact: boolean }).showContact, false);
});
check('draws the badge, the week with today marked, the closed day, the address and four buttons', () => {
    const html = renderSitePage(site(), '/', live).html;
    assert.ok(html.includes('<p class="badge on"><strong>Open now · closes 5pm</strong></p>'));
    assert.ok(html.includes('<tr class="today"><th scope="row">Wednesday</th><td>9am–5pm</td></tr>'));
    assert.ok(html.includes('(Staff training)'));
    assert.ok(html.includes('<address>12 High Street<br>Leeds<br>LS1 4AB</address>'));
    assert.ok(html.includes('href="tel:01134960000"'));
    assert.ok(html.includes('href="https://wa.me/447700900123"'));
    assert.ok(html.includes('href="mailto:hello@example.com"'));
    assert.ok(html.includes('https://www.google.com/maps/dir/?api=1&amp;destination='));
});
check('the home page tells search engines the hours and street address', () => {
    const html = renderSitePage(site(), '/', live).html;
    assert.ok(html.includes('"openingHoursSpecification"'));
    assert.ok(html.includes('"streetAddress":"12 High Street, Leeds, LS1 4AB"'));
    assert.ok(html.includes('"addressLocality":"Leeds"'));
});
check('parts switched off are left out; missing details leave out only their button', () => {
    const html = renderSitePage(site({ showHours: false }, { email: 'hello@example.com' }), '/', { ...live, business: { ...business, whatsapp: null } }).html;
    assert.ok(!html.includes('class="badge'));
    assert.ok(!html.includes('href="tel:'));
    assert.ok(!html.includes('wa.me'));
    assert.ok(html.includes('mailto:hello@example.com'));
});
check('with nothing to show it is absent from the live site, and explained in the preview', () => {
    const empty = { ...live, business: null };
    const liveHtml = renderSitePage(site({}, {}), '/', empty).html;
    assert.ok(!liveHtml.includes('id="hr1"'));
    const preview = renderSitePage(site({}, {}), '/', { ...empty, preview: true }).html;
    assert.ok(preview.includes('Hours &amp; Location'));
});
check('a closed day today shows Closed even inside the usual hours', () => {
    const html = renderSitePage(site(), '/', { ...live, business: { ...business, closures: [{ date: '2026-10-14' }] } }).html;
    assert.ok(html.includes('<p class="badge off"><strong>Closed · opens tomorrow at 9am</strong></p>'));
});

console.log('\nWiring');

check('both renderers load the hours; the editor, chat and Business Information know the section', () => {
    assert.ok(read('netlify/functions/site-serve.ts').includes('business: await businessSummary(db, site.organisationId)'));
    assert.ok(read('netlify/functions/site-preview.ts').includes('business: await businessSummary(db, ctx.organisationId)'));
    const editor = read('src/components/assistant-site-editor.js');
    assert.ok(editor.includes("hours: 'Opening hours & contact'") && editor.includes("kind: 'hoursInfo'"));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('OPENING HOURS & HOW TO REACH THEM') && chat.includes('hours {heading, intro, showHours, showAddress, showContact'));
    const ui = read('assets.html');
    assert.ok(ui.includes('id="bh-address"') && ui.includes('id="bh-whatsapp"') && ui.includes("visitAddress: $('bh-address').value"));
});

console.log(`\n${passed}/${total} passed\n`);
