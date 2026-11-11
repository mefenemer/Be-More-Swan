// tests/site-booking-page.test.ts
// The booking link of its own (docs/booking-calendly-gaps-plan.md A): /book on the site address,
// published or not; the booking link's own sections; per-service links; the line every drafting
// assistant reads; and the wiring (site-serve, the Website tab, chat).
//
// Run:  npx tsx tests/site-booking-page.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingOnlyDefinition, bookingsSwitchedOff, describeBookingLink, serviceKind, siteSectionsByKind } from '../src/utils/site-booking-page';
import { bookLink, findBookingSection, readChoice, sectionForKind, virtualSection, virtualSectionId, VIRTUAL_SECTIONS } from '../src/utils/site-booking';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { BOOKING_PAGE_PATH } from '../src/utils/site-render';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const SITE = normaliseSiteDefinition({
    version: 1, settings: { siteName: 'Willow Salon' },
    pages: [
        { id: 'home', slug: '', title: 'Home', sections: [{ id: 'bk1', type: 'booking', props: { kind: 'appointment', heading: 'Book a cut', serviceIds: [5], askStaff: true } }] },
        { id: 'p2', slug: 'classes', title: 'Classes', sections: [{ id: 'cl1', type: 'booking', props: { kind: 'class', heading: 'Classes', serviceIds: [] } }] },
    ],
}, { maxPages: 10 }).definition;

check('the booking link\'s own sections: one per kind, ids starting with _', () => {
    assert.deepStrictEqual(Object.values(VIRTUAL_SECTIONS).sort(), ['appointment', 'class', 'consultation', 'table']);
    for (const id of Object.keys(VIRTUAL_SECTIONS)) assert.ok(id.startsWith('_'));
    const v = virtualSection('_consultation')!;
    assert.strictEqual(v.section.props.kind, 'consultation');
    assert.deepStrictEqual(v.section.props.serviceIds, [], 'every service');
    assert.strictEqual(v.pagePath, BOOKING_PAGE_PATH);
    assert.strictEqual(v.virtual, true);
    assert.strictEqual(virtualSection('_nope'), null);
    assert.strictEqual(virtualSection('__proto__'), null);
    assert.strictEqual(virtualSectionId('table'), '_table');
});

check('a real section wins; an unknown id falls back to the booking link\'s own only when it is one', () => {
    const real = findBookingSection(SITE, 'bk1')!;
    assert.ok(!real.virtual && real.section.props.heading === 'Book a cut' && real.pagePath === '/');
    assert.ok(findBookingSection(SITE, '_appointment')!.virtual);
    assert.strictEqual(findBookingSection(SITE, 'gone'), null);
    // An empty (booking-only) definition still finds the booking link's own sections.
    assert.ok(findBookingSection(bookingOnlyDefinition(SITE), '_table')!.virtual);
});

check('a move or a waitlist offer starts from the site\'s section, else the booking link\'s', () => {
    assert.strictEqual(sectionForKind(SITE, 'appointment'), 'bk1');
    assert.strictEqual(sectionForKind(SITE, 'class'), 'cl1');
    assert.strictEqual(sectionForKind(SITE, 'table'), '_table');
    assert.strictEqual(sectionForKind(bookingOnlyDefinition(SITE), 'class'), '_class');
    assert.strictEqual(sectionForKind(SITE, 'nonsense'), null);
});

check('the step links carry a booking link section id', () => {
    const link = bookLink({ s: '_appointment', svc: 5, party: 0, res: 3, date: null, time: null });
    const q = new URLSearchParams(link.split('?')[1]);
    assert.deepStrictEqual(readChoice(q), { s: '_appointment', svc: 5, party: 0, res: 3, date: null, time: null, mv: null, mt: null });
});

check('services worded as consultations only when every one is a call', () => {
    assert.strictEqual(serviceKind([{ meetingLocation: 'video' }, { meetingLocation: 'phone' }]), 'consultation');
    assert.strictEqual(serviceKind([{ meetingLocation: 'video' }, { meetingLocation: null }]), 'appointment');
    assert.strictEqual(serviceKind([]), 'appointment');
});

check('a published site\'s own sections, first of each kind', () => {
    const m = siteSectionsByKind(SITE);
    assert.deepStrictEqual([...m.keys()], ['appointment', 'class']);
    assert.deepStrictEqual(m.get('appointment'), { id: 'bk1', heading: 'Book a cut', serviceIds: [5] });
    assert.strictEqual(siteSectionsByKind(null).size, 0);
});

check('booking-only: the look and details, nothing of the draft\'s pages or menu', () => {
    const d = bookingOnlyDefinition(SITE);
    assert.deepStrictEqual(d.pages, []);
    assert.deepStrictEqual(d.nav, []);
    assert.strictEqual(d.settings.siteName, 'Willow Salon');
    assert.deepStrictEqual(d.theme, SITE.theme);
    assert.strictEqual(SITE.pages.length, 2, 'the draft itself untouched');
});

check('switching Bookings off in what the website does turns the link off', () => {
    assert.strictEqual(bookingsSwitchedOff(SITE), false, 'never chosen = everything offered');
    assert.strictEqual(bookingsSwitchedOff({ settings: { ...SITE.settings, features: ['shop'] } }), true);
    assert.strictEqual(bookingsSwitchedOff({ settings: { ...SITE.settings, features: ['bookings'] } }), false);
});

check('drafting assistants: the exact link, or no line at all', () => {
    const line = describeBookingLink('https://willow.bemoreswan.site/book');
    assert.ok(line.includes('https://willow.bemoreswan.site/book') && /never make up/.test(line));
    assert.strictEqual(describeBookingLink(null), '');
});

check('wiring: site-serve, the Website tab, chat, drafting', () => {
    const serve = read('netlify/functions/site-serve.ts');
    assert.ok(serve.includes("const BOOKING_ONLY_PATHS = new Set(['/', BOOKING_PAGE_PATH, BOOK_PATH, FORM_SENT_PATH, '/robots.txt'])"));
    assert.ok(serve.includes("site.status === 'draft' && BOOKING_ONLY_PATHS.has(path)"), 'only a draft — never a suspended site');
    assert.ok(serve.includes('await bookingOnlySite(db, site, new Date())'));
    assert.ok(read('src/utils/site-booking-page.ts').includes('bookingOnlyAllowed(db, site, draft, now)) ? bookingOnlyDefinition(draft)'), 'only the look of the draft — never its pages');
    const page = read('src/utils/site-booking-page.ts');
    assert.ok(page.includes("if (!a || a.archivedAt) return false;"), 'an archived Website Assistant takes no bookings');
    assert.ok(serve.includes("creditUrl: site.credit || bookingOnly"), 'credit on every plan');
    assert.ok(serve.includes("!definition.pages.some((p) => p.slug === 'book')"), 'a page of their own at /book wins');
    assert.ok(serve.includes("if (isPost && path !== BOOK_PATH) return { statusCode: 405"), 'booking-only takes only booking posts');
    assert.ok(read('netlify/functions/sites.ts').includes('const bookLinkUrl = origin && kinds.length'), 'the Website tab gets the link');
    assert.ok(read('src/components/assistant-site-editor.js').includes('function bookingLinkCard()'));
    assert.ok(read('src/utils/site-store.ts').includes('bookingLinkFor(db, orgId)'), 'the Website chat sees it');
    assert.ok(read('src/utils/org-products.ts').includes("import('./site-booking-page')"), 'every drafting assistant reads it, never fatally');
});

console.log(`\n${passed}/${total} passed`);
