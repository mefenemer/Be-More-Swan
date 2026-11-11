// tests/site-menu-dropdowns.test.ts — drop-down menus on hosted sites (SitePageDef.menuParent).
//
// WHY THIS EXISTS. Prod 2026-11-08 (Restorative Futures, org 41): their 13 pages imported, but a
// hosted menu holds 7 entries and had no drop-downs, so Contact Us, Booking & Pricing and Blogs fell
// out of it. Their old site kept the menu short with "About Us ▾" and "Our Courses ▾". Now a page can
// sit under another in the menu, the import reads their drop-downs, and the owner (Pages tab) or the
// chat (update_page menuParent) can change it.
//
// Run:  npx tsx tests/site-menu-dropdowns.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applySiteOperation, menuOf, normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { readImportPage } from '../src/utils/site-extract';
import { runImport } from '../src/utils/site-import';
import { renderSitePage } from '../src/utils/site-render';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

const page = (id: string, slug: string, title: string, extra: Record<string, unknown> = {}) => ({ id, slug, title, sections: [{ type: 'text', props: { heading: title, body: `${title} words.` } }], ...extra });
const site = (pages: unknown[]): SiteDefinition => normaliseSiteDefinition({ settings: { siteName: 'Test' }, pages }, { maxPages: 100 }).definition;
const opts = { maxPages: 100 };

const RF_LIKE = site([
    page('p1', '', 'Home'),
    page('p2', 'about-us', 'About Us'),
    page('p3', 'testimonials', 'Testimonials', { menuParent: 'p2' }),
    page('p4', 'faqs', 'FAQs', { menuParent: 'p2' }),
    page('p5', 'our-courses', 'Our Courses'),
    ...[6, 7, 8, 9, 10].map((n) => page(`p${n}`, `course-${n}`, `Course ${n}`, { menuParent: 'p5' })),
    page('p11', 'booking-pricing', 'Booking & Pricing'),
    page('p12', 'blogs', 'Blogs'),
    page('p13', 'contact', 'Contact Us'),
]);

(async () => {
await check('13 pages, 6 menu entries: every page is in the menu (Contact and Booking too)', () => {
    const menu = menuOf(RF_LIKE);
    assert.deepStrictEqual(menu.map((m) => m.label), ['Home', 'About Us', 'Our Courses', 'Booking & Pricing', 'Blogs', 'Contact Us']);
    assert.deepStrictEqual(menu[1].children?.map((c) => c.path), ['/testimonials', '/faqs']);
    assert.strictEqual(menu[2].children?.length, 5);
    assert.ok(!menu[0].children, 'no empty drop-down');
});

await check('the gate drops a parent that is missing, the home page, itself, or under another page', () => {
    const d = site([
        page('p1', '', 'Home'),
        page('p2', 'a', 'A', { menuParent: 'p1' }),       // under home → own entry
        page('p3', 'b', 'B', { menuParent: 'nope' }),     // missing → own entry
        page('p4', 'c', 'C', { menuParent: 'p4' }),       // itself → own entry
        page('p5', 'd', 'D'),
        page('p6', 'e', 'E', { menuParent: 'p5' }),
        page('p7', 'f', 'F', { menuParent: 'p6' }),       // under a page that is under another → own entry
    ]);
    const by = (id: string) => d.pages.find((p) => p.id === id)!;
    assert.strictEqual(by('p2').menuParent, null);
    assert.strictEqual(by('p3').menuParent, null);
    assert.strictEqual(by('p4').menuParent, null);
    assert.strictEqual(by('p6').menuParent, 'p5');
    assert.strictEqual(by('p7').menuParent, null);
});

await check('update_page menuParent: set, clear, and the refusals say why', () => {
    const d = site([page('p1', '', 'Home'), page('p2', 'courses', 'Courses'), page('p3', 'one', 'One'), page('p4', 'two', 'Two', { menuParent: 'p2' })]);
    const set = applySiteOperation(d, { op: 'update_page', pageId: 'p3', menuParent: 'p2' }, opts);
    assert.ok(set.ok && set.definition.pages.find((p) => p.id === 'p3')!.menuParent === 'p2');
    // By the parent's address too (a card names pages it added by their address).
    const bySlug = applySiteOperation(d, { op: 'update_page', pageId: 'p3', menuParent: 'courses' }, opts);
    assert.ok(bySlug.ok && bySlug.definition.pages.find((p) => p.id === 'p3')!.menuParent === 'p2');
    const clear = applySiteOperation(d, { op: 'update_page', pageId: 'p4', menuParent: null }, opts);
    assert.ok(clear.ok && clear.definition.pages.find((p) => p.id === 'p4')!.menuParent === null);
    const home = applySiteOperation(d, { op: 'update_page', pageId: 'p3', menuParent: 'p1' }, opts);
    assert.ok(!home.ok && /home page/.test(home.error), JSON.stringify(home));
    const nested = applySiteOperation(d, { op: 'update_page', pageId: 'p3', menuParent: 'p4' }, opts);
    assert.ok(!nested.ok && /itself under another page/.test(nested.error));
    const hasKids = applySiteOperation(d, { op: 'update_page', pageId: 'p2', menuParent: 'p3' }, opts);
    assert.ok(!hasKids.ok && /Other pages are under/.test(hasKids.error));
});

await check('removing a page gives the pages under it their own place again', () => {
    const r = applySiteOperation(RF_LIKE, { op: 'remove_page', pageId: 'p2' }, opts);
    assert.ok(r.ok);
    assert.ok(r.definition.pages.filter((p) => p.slug === 'testimonials' || p.slug === 'faqs').every((p) => !p.menuParent));
    assert.ok(menuOf(r.definition).some((m) => m.label === 'Testimonials'));
});

await check('a hidden parent: its pages stand on their own rather than vanish from the menu', () => {
    const r = applySiteOperation(RF_LIKE, { op: 'update_page', pageId: 'p2', hideFromMenu: true }, opts);
    assert.ok(r.ok);
    const labels = menuOf(r.definition).map((m) => m.label);
    assert.ok(labels.includes('Testimonials') && labels.includes('FAQs') && !labels.includes('About Us'), labels.join(', '));
});

await check('drawn as a nested list; CSS-only drop-down (no script on hosted sites), stacked on a phone', () => {
    const html = renderSitePage(RF_LIKE, '/testimonials', { origin: 'https://x.test', preview: false, reportUrl: '/r', creditUrl: null }).html;
    assert.ok(html.includes('<li class="has-sub"><a href="/about-us">About Us</a><ul class="sub"><li><a href="/testimonials" aria-current="page">Testimonials</a></li>'), html.slice(html.indexOf('<nav'), html.indexOf('</nav>')));
    assert.ok(html.includes('.nav .has-sub:hover>.sub,.nav .has-sub:focus-within>.sub{display:block}'), 'opens on hover and keyboard focus');
    assert.ok(html.includes('@media(max-width:720px){.nav .has-sub{flex-basis:100%}.nav .sub{display:block;position:static'), 'phone: always open, stacked');
    assert.ok(!/<script(?![^>]*application\/ld\+json)/.test(html), 'no script');
});

// ── The import reads their drop-downs ──────────────────────────────────────────────────────────

const RF_NAV = `<header><nav aria-label="Primary">
<a href="/">Home</a>
<div class="nav-dropdown"><div class="nav-dropdown__head"><a href="/about-us">About Us</a><button aria-label="Show more"></button></div>
  <div class="nav-dropdown__panel"><a href="/about-us">About Us</a><a href="/testimonials">Testimonials</a><a href="/faqs">FAQs</a></div></div>
<div class="nav-dropdown"><div class="nav-dropdown__head"><a href="/our-courses">Our Courses</a></div>
  <div class="nav-dropdown__panel"><a href="/our-courses">All courses</a><a href="/conferencing">Conferencing skills</a></div></div>
<a href="/contact">Contact Us</a></nav></header>`;

await check('menu links know their drop-down: builder panel (Restorative Futures), WordPress sub-menu, <details>', () => {
    const rf = readImportPage(`<html><body>${RF_NAV}<main><p>Hello there.</p></main></body></html>`, 'https://rf.test/');
    assert.deepStrictEqual(rf.navLinks.map((l) => [l.text, l.group ?? null]), [
        ['Home', null], ['About Us', null], ['Testimonials', 'About Us'], ['FAQs', 'About Us'], ['Our Courses', null], ['Conferencing skills', 'Our Courses'], ['Contact Us', null],
    ]);
    const wp = readImportPage(`<html><body><nav><ul class="menu"><li><a href="/">Home</a></li><li class="menu-item-has-children"><a href="/services">Services</a><ul class="sub-menu"><li><a href="/plumbing">Plumbing</a></li></ul></li></ul></nav></body></html>`, 'https://wp.test/');
    assert.deepStrictEqual(wp.navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Services', null], ['Plumbing', 'Services']]);
    const det = readImportPage(`<html><body><nav><a href="/">Home</a><details><summary>Shop</summary><a href="/mugs">Mugs</a></details></nav></body></html>`, 'https://d.test/');
    assert.strictEqual(det.navLinks.find((l) => l.text === 'Mugs')?.group, 'Shop');
});

await check('the import puts each page under its drop-down\'s page in the new menu', async () => {
    const body = (t: string) => `<html><head><title>${t}</title></head><body>${RF_NAV}<main><h1>${t}</h1><p>${`The ${t} page has plenty of its own words for the import to read. `.repeat(4)}</p></main></body></html>`;
    const urls: Record<string, string> = { '/': 'Home', '/about-us': 'About Us', '/testimonials': 'Testimonials', '/faqs': 'FAQs', '/our-courses': 'Our Courses', '/conferencing': 'Conferencing skills', '/contact': 'Contact Us' };
    const current = normaliseSiteDefinition({ settings: { siteName: 'RF' } }, opts).definition;
    const out = await runImport({ url: 'https://rf.test/', pictures: 'skip', current, maxPages: 100 }, {
        fetchHtml: async (u: string) => { const p = new URL(u).pathname; return urls[p] ? { ok: true as const, html: body(urls[p]), finalUrl: u } : { ok: false as const, message: 'no' }; },
        plan: async () => null, savePicture: async () => null,
    });
    assert.ok(out.ok, out.ok ? '' : out.message);
    if (!out.ok) return;
    const menu = menuOf(out.definition);
    assert.deepStrictEqual(menu.map((m) => m.label), ['Home', 'About Us', 'Our Courses', 'Contact Us']);
    assert.deepStrictEqual(menu[1].children?.map((c) => c.path), ['/testimonials', '/faqs']);
    assert.deepStrictEqual(menu[2].children?.map((c) => c.path), ['/conferencing']);
});

await check('wired: Pages tab picker, chat update_page and its snapshot, card wording', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('${menuPlaceHtml(p)}'));
    assert.ok(ed.includes("<select data-site-page-under"));
    assert.ok(ed.includes("if (under && (under.value || null) !== (p.menuParent || null)) op.menuParent = under.value || null;"));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('"hideFromMenu":true|false,"menuParent":"<pageId>"|null}'));
    assert.ok(read('src/utils/site-store.ts').includes(', in the menu UNDER "'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("'Put a page in a drop-down in the menu'"));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
})();
