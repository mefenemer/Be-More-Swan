// tests/site-listings.test.ts — Listings (docs/website-types-plan.md §4): an events calendar or a
// directory on a customer's site, from the workspace's own entries; visitors' entries wait for approval.
//
// Run:  npx tsx tests/site-listings.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normaliseSiteDefinition, RESERVED_SLUGS, SITE_FEATURES } from '../src/utils/site-definition';
import { renderSitePage, renderSiteListing, renderSitemap, type RenderContext } from '../src/utils/site-render';
import {
    checkWhole, cleanLink, cleanListing, isUpcoming, listingIcs, listingLd, listingRoute, listingsFor, listingSlugBase,
    sortListings, ukToday, validDate, validTime, whenText, type SiteRenderListing, type SiteRenderListings,
} from '../src/utils/site-listings';
import { listingPostPage } from '../src/utils/site-listing-post';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
const checks: [string, () => void | Promise<void>][] = [];
const check = (name: string, fn: () => void | Promise<void>) => checks.push([name, fn]);

const L = (o: Partial<SiteRenderListing>): SiteRenderListing => ({
    id: 1, kind: 'event', slug: 'x', title: 'X', category: null, summary: null, body: null, startsOn: null, startTime: null, endsOn: null, endTime: null,
    when: '', location: null, imageAssetId: null, imageAlt: null, linkUrl: null, linkLabel: null, ...o,
});
const DATA: SiteRenderListings = {
    today: '2026-06-10',
    all: [
        L({ id: 1, slug: 'rebetiko-night', title: 'Rebetiko night', category: 'Music', startsOn: '2026-06-14', startTime: '21:00', location: 'Ermoupoli harbour', summary: 'Live rebetiko by the water.' }),
        L({ id: 2, slug: 'loukoumi-workshop', title: 'Loukoumi workshop', category: 'Food & drink', startsOn: '2026-06-12', startTime: '10:00' }),
        L({ id: 3, slug: 'old-fair', title: 'Old fair', category: 'Music', startsOn: '2026-05-01' }),
        L({ id: 4, slug: 'festival', title: 'Three-day festival', category: 'Festival', startsOn: '2026-06-08', endsOn: '2026-06-11' }),
        L({ id: 5, kind: 'entry', slug: 'harbour-cafe', title: 'Harbour Café', category: 'Cafés' }),
    ],
};
const SITE = normaliseSiteDefinition({
    settings: { siteName: 'Syros Events', features: ['listings'] },
    pages: [
        { id: 'home', slug: '', title: 'Home', sections: [
            { id: 'hero', type: 'hero', props: { headline: 'What\'s happening on Syros' } },
            { id: 'on', type: 'listings', props: { kind: 'event', heading: 'Coming up', allowPosts: true } },
        ] },
        { id: 'places', slug: 'places', title: 'Places', sections: [{ id: 'dir', type: 'listings', props: { kind: 'entry', layout: 'list' } }] },
    ],
}).definition;
const ctx = (o: Partial<RenderContext> = {}): RenderContext => ({ origin: 'https://syros.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, listings: DATA, ...o });

check('the section is a real section type behind its own feature, and /listings is a reserved address', () => {
    assert.ok((SITE_FEATURES as readonly string[]).includes('listings'));
    assert.ok(RESERVED_SLUGS.has('listings'));
    const s = SITE.pages[0].sections[1];
    assert.strictEqual(s.type, 'listings');
    if (s.type !== 'listings') return;
    assert.deepStrictEqual({ kind: s.props.kind, show: s.props.show, count: s.props.count, filter: s.props.filter, allowPosts: s.props.allowPosts, postLabel: s.props.postLabel },
        { kind: 'event', show: 'upcoming', count: 12, filter: true, allowPosts: true, postLabel: 'Post your event' });
    const d = normaliseSiteDefinition({ pages: [{ title: 'Listings', slug: 'listings', sections: [{ type: 'text', props: { body: 'x' } }] }] }).definition;
    assert.notStrictEqual(d.pages[0].slug, 'listings', 'a page may not take /listings');
});

check('cleaning: dates and times as typed, real dates only, links made safe, an event needs a date', () => {
    assert.strictEqual(validDate('2026-02-30'), null);
    assert.strictEqual(validDate('2026-06-14'), '2026-06-14');
    assert.strictEqual(validTime('7:30'), '07:30');
    assert.strictEqual(validTime('24:00'), null);
    assert.strictEqual(cleanLink('tickets.example.com/syros'), 'https://tickets.example.com/syros');
    assert.strictEqual(cleanLink('javascript:alert(1)'), null);
    assert.strictEqual(cleanLink('mailto:hi@example.com'), 'mailto:hi@example.com');
    const ok = cleanListing({ kind: 'event', title: '  Jazz   night ', startsOn: '2026-07-01', startTime: '19:30', linkUrl: 'example.com' }, false);
    assert.ok(ok.ok && ok.value.title === 'Jazz night' && ok.value.startTime === '19:30' && ok.value.linkUrl === 'https://example.com/');
    assert.ok(!cleanListing({ title: 'x', linkUrl: 'javascript:x' }, false).ok);
    assert.ok(!cleanListing({ title: '' }, false).ok);
    assert.strictEqual(checkWhole({ kind: 'event', startsOn: null, endsOn: null, startTime: null, endTime: null, imageAssetId: null, imageAlt: null }), 'An event needs the date it starts.');
    assert.ok(checkWhole({ kind: 'event', startsOn: '2026-07-02', endsOn: '2026-07-01', startTime: null, endTime: null, imageAssetId: null, imageAlt: null }));
    assert.ok(checkWhole({ kind: 'entry', startsOn: null, endsOn: null, startTime: null, endTime: null, imageAssetId: 4, imageAlt: null }), 'a picture needs words');
    assert.strictEqual(listingSlugBase('Café Night — Ano Syros!'), 'cafe-night-ano-syros');
});

check('upcoming, sorted, filtered: past events drop off; a multi-day event shows until its last day', () => {
    const p = { kind: 'event' as const, categories: [], show: 'upcoming' as const, count: 12 };
    assert.deepStrictEqual(listingsFor(DATA, p).map((l) => l.id), [4, 2, 1], 'festival (on now), then by date; the May fair gone');
    assert.deepStrictEqual(listingsFor(DATA, { ...p, show: 'all' }).map((l) => l.id), [3, 4, 2, 1]);
    assert.deepStrictEqual(listingsFor(DATA, { ...p, categories: ['music'] }).map((l) => l.id), [1]);
    assert.deepStrictEqual(listingsFor(DATA, p, 'Food & drink').map((l) => l.id), [2]);
    assert.deepStrictEqual(listingsFor(DATA, { ...p, kind: 'entry' }).map((l) => l.id), [5]);
    assert.ok(isUpcoming({ kind: 'event', startsOn: '2026-06-08', endsOn: '2026-06-11' }, '2026-06-11'));
    assert.ok(!isUpcoming({ kind: 'event', startsOn: '2026-06-08', endsOn: '2026-06-11' }, '2026-06-12'));
    assert.deepStrictEqual(sortListings([{ kind: 'entry', startsOn: null, startTime: null, title: 'B' }, { kind: 'entry', startsOn: null, startTime: null, title: 'A' }]).map((x) => x.title), ['A', 'B']);
    assert.match(ukToday(new Date('2026-06-30T23:30:00Z')), /^2026-07-01$/, 'UK date, not UTC, in summer time');
});

check('words for dates', () => {
    assert.strictEqual(whenText({ startsOn: '2026-06-14', startTime: '21:00', endsOn: null, endTime: '23:30' }), 'Sun 14 Jun 2026, 21:00–23:30');
    assert.strictEqual(whenText({ startsOn: '2026-08-01', startTime: null, endsOn: '2026-08-03', endTime: null }), 'Sat 1 Aug 2026 – Mon 3 Aug 2026');
    assert.strictEqual(whenText({ startsOn: null, startTime: null, endsOn: null, endTime: null }), '');
});

check('the section draws cards, a category filter of plain links, and "Post your event"', () => {
    const html = renderSitePage(SITE, '/', ctx({ query: 'category=Music' })).html;
    assert.ok(html.includes('href="/listings/rebetiko-night"'));
    assert.ok(!html.includes('loukoumi-workshop'), 'the Music filter is applied from the query');
    assert.match(html, /<nav class="lf" aria-label="Show by category"><a href="\/#on">All<\/a>/);
    assert.ok(html.includes('href="/?category=Music#on" aria-current="true"'));
    assert.ok(html.includes('href="/_post?s=on&amp;p=%2F"'), 'the post button carries its section');
    assert.ok(!/<script(?! type="application\/ld\+json")/.test(html), 'no script on a customer site');
    const places = renderSitePage(SITE, '/places', ctx()).html;
    assert.ok(places.includes('<ul class="ls">') && places.includes('Harbour Café'));
    // The preview: the filter arrives inside the path.
    assert.ok(renderSitePage(SITE, '/?category=Festival', ctx({ preview: true })).html.includes('Three-day festival'));
    const empty = renderSitePage(SITE, '/', ctx({ listings: { all: [], today: '2026-06-10' } })).html;
    assert.ok(empty.includes('Nothing coming up just now'));
});

check('each listing has its own page: Event data for search engines, Add to calendar, a link back', () => {
    const l = { ...DATA.all[0], when: whenText(DATA.all[0]) };
    const html = renderSiteListing(SITE, ctx(), l);
    assert.ok(html.includes('<h1>Rebetiko night</h1>'));
    assert.ok(html.includes('href="/listings/rebetiko-night.ics" download>Add to calendar'));
    assert.ok(html.includes('"@type":"Event"') && html.includes('"startDate":"2026-06-14T21:00"'));
    assert.ok(html.includes('<link rel="canonical" href="https://syros.bemoreswan.site/listings/rebetiko-night">'));
    assert.ok(html.includes('← Home'));
    assert.deepStrictEqual(listingRoute('/listings/rebetiko-night'), { slug: 'rebetiko-night', ics: false });
    assert.deepStrictEqual(listingRoute('/listings/rebetiko-night.ics'), { slug: 'rebetiko-night', ics: true });
    assert.strictEqual(listingRoute('/listings/a/b'), null);
    assert.strictEqual(listingRoute('/listings/<x>'), null);
    assert.strictEqual(listingLd(DATA.all[4], 'S', 'u', null)['@type'], 'Thing');
    const sm = renderSitemap(SITE, 'https://syros.bemoreswan.site', [], [{ slug: 'rebetiko-night', lastmod: '2026-06-01T10:00:00Z' }]);
    assert.ok(sm.includes('<loc>https://syros.bemoreswan.site/listings/rebetiko-night</loc><lastmod>2026-06-01</lastmod>'));
});

check('the calendar file is valid iCalendar, in UK time, with an all-day form', () => {
    const ics = listingIcs({ ...DATA.all[0], when: '' }, 'Syros, Events', 'https://syros.bemoreswan.site/listings/rebetiko-night', new Date('2026-06-01T00:00:00Z'))!;
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(ics.includes('DTSTART;TZID=Europe/London:20260614T210000'));
    assert.ok(ics.includes('PRODID:-//Be More Swan//Syros\\, Events//EN'), 'commas escaped');
    assert.ok(ics.split('\r\n').every((line) => line.length <= 75), 'lines folded');
    const allDay = listingIcs({ ...DATA.all[3], when: '' }, 'S', 'https://x')!;
    assert.ok(allDay.includes('DTSTART;VALUE=DATE:20260608') && allDay.includes('DTEND;VALUE=DATE:20260612'), 'end is the day after the last day');
    assert.strictEqual(listingIcs({ ...DATA.all[4], when: '' }, 'S', 'https://x'), null, 'entries have no calendar file');
});

check('a visitor\'s form: only where the section allows it, and it says the owner reads it first', () => {
    const b = { db: null as never, site: { organisationId: 1 } as never, def: SITE, ctx: ctx(), now: new Date('2026-06-10T09:00:00Z') };
    const form = listingPostPage(b, new URLSearchParams({ s: 'on' }));
    assert.ok('html' in form && form.status === 200);
    if (!('html' in form)) return;
    assert.ok(form.html.includes('name="_k" value="listing"') && form.html.includes('name="website"'), 'kind + honeypot');
    assert.ok(form.html.includes('reads everything sent in before it appears'));
    assert.ok(form.html.includes('never shown'));
    const closed = listingPostPage(b, new URLSearchParams({ s: 'dir' }));
    assert.strictEqual(closed.status, 404, 'a section that doesn\'t allow posts has no form');
    const src = read('src/utils/site-listing-post.ts');
    assert.ok(src.includes("status: 'pending', source: 'public'"), 'saved pending — never live before approval');
    assert.ok(src.includes("checkRateLimit(b.db, 'site_listing_ip'"), 'a cap per address');
});

check('the server: site-serve routes, the owner\'s API is tenant-scoped, the chat proposes and never writes', () => {
    const serve = read('netlify/functions/site-serve.ts');
    assert.ok(serve.includes("if (posted.get('_k') === 'listing')") && serve.includes('if (path === LISTING_POST_PATH)'));
    assert.ok(serve.includes("'text/calendar; charset=utf-8'"));
    const api = read('netlify/functions/site-listings.ts');
    assert.ok(api.includes('requireTenant(event, db)'));
    assert.strictEqual((api.match(/eq\(siteListings\.organisationId, orgId\)/g) || []).length >= 6, true, 'every statement scoped');
    assert.ok(api.includes("eq(siteListings.status, 'pending')"), 'a decision only on a waiting entry');
    const cards = read('src/components/disruptive-ui-registry.js');
    assert.ok(cards.includes("register('listings_add'") && cards.includes("register('listing_decisions'"));
    const session = read('src/components/chat-session.js');
    for (const evt of ['site:listingsAdd', 'site:listingDecisions']) assert.ok(session.includes(`container.addEventListener('${evt}'`) && session.includes(`container.removeEventListener('${evt}'`));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('never invent an event, a date, a time, a place or a link'));
    assert.ok(chat.includes('"type":"listings_add"') && chat.includes('"type":"listing_decisions"'));
    assert.ok(read('db/z-site-listings.sql').includes("CHECK (status IN ('published', 'hidden', 'pending', 'declined'))"));
});

check('the editor: a Listings tab with approve / decline, and the section form points to it', () => {
    const ed = read('src/components/assistant-site-editor.js');
    for (const b of ["'+ Add a listing'", "'Approve'", "'Decline'", "'Hide'", "'Delete'", 'Waiting for you']) assert.ok(ed.includes(b), b);
    assert.ok(ed.includes("show('maintab-btn-sitelistings', listingsOn())"));
    const html = read('assistant-detail.html');
    assert.ok(html.includes('id="maintab-btn-sitelistings" data-maintab="sitelistings"') && html.includes('data-site-host="listings"'));
    assert.ok(read('assistants.js').includes("if (name === 'sitelistings') siteEditor((ed) => ed.activate('listings'));"));
});

(async () => {
    for (const [name, fn] of checks) {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { console.log(`  ✗ ${name}\n    ${(err as Error).message}`); }
    }
    console.log(`\n${passed}/${checks.length} passed`);
    if (passed !== checks.length) process.exit(1);
})();
