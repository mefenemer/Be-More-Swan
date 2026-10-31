// tests/site-builder.test.ts
// The Website Assistant's site definition (src/utils/site-definition.ts) and renderer
// (src/utils/site-render.ts) — docs/website-assistant-plan.md step 1.
//
// Run:  npx tsx tests/site-builder.test.ts
//
// What matters, in order:
//  1. Nothing a user or a model types becomes markup, script or a dangerous link.
//  2. The gate always returns a site that renders: one home page, unique addresses, the plan's page
//     cap, readable colours — and it says what it changed, in words.
//  3. Every operation goes through the gate, refuses what would break a rule, and never mutates
//     the definition it was given.
//  4. Every rendered page has exactly one <h1>, and a site we build passes the Mystery Shopper's own
//     code checks — we should never sell a site our own critic would mark down on the basics.

import assert from 'node:assert';
import {
    applySiteOperation, cleanHref, normaliseSiteDefinition, slugify, DEFAULT_MAX_PAGES, DEFAULT_THEME, type SiteDefinition,
} from '../src/utils/site-definition';
import { esc, jsonLd, renderRobots, renderSitemap, renderSitePage, type RenderContext } from '../src/utils/site-render';
import { extractSitePage } from '../src/utils/site-extract';
import { runDeterministicChecks } from '../src/utils/site-score';
import { contrastRatio } from '../src/utils/brand-kit';
import schemas from '../src/public/assistant-onboarding-schemas.js';
import { CONVERSION_GOALS } from '../src/utils/site-audit-setup';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

/** A complete, realistic site — Willowbrook Coffee, fictional. */
const GOOD = {
    theme: { primaryColor: '#2D6A4F', textColor: '#1f2937', backgroundColor: '#ffffff', font: 'sans', radius: 'medium' },
    settings: { siteName: 'Willowbrook Coffee', description: 'Fresh-roasted coffee for independent cafés in Yorkshire, delivered within 48 hours of roasting.', businessType: 'LocalBusiness', locality: 'Leeds', email: 'hello@willowbrook.example', phone: '0113 496 0000' },
    nav: [],
    pages: [
        { id: 'home', slug: '', title: 'Home', seo: { title: 'Wholesale coffee for Yorkshire cafés | Willowbrook', description: null }, sections: [
            { id: 'hero', type: 'hero', props: { layout: 'split', eyebrow: 'Roasted in Leeds', headline: 'Fresh-roasted coffee for independent cafés in Yorkshire', subheadline: 'Roasted to order and delivered within 48 hours, so your coffee is never more than a week from the roaster.', primaryCta: { label: 'Get a wholesale quote', href: '/contact' }, secondaryCta: { label: 'How it works', href: '#how' }, image: { url: 'https://cdn.example/roastery.jpg', alt: 'Our roaster in Leeds' } } },
            { id: 'how', type: 'steps', props: { heading: 'How wholesale works', items: [{ title: 'Taste', body: 'We send a free tasting box.' }, { title: 'Choose', body: 'Pick your blends.' }, { title: 'Relax', body: 'Weekly deliveries, no contract.' }] } },
            { id: 'proof', type: 'features', props: { heading: 'Why cafés switch', items: [{ title: '48-hour freshness', body: 'Roasted Monday, in your hopper by Wednesday.' }, { title: 'Supplying 40 cafés', body: 'Across Leeds, York and Harrogate since 2019.' }] } },
            { id: 'says', type: 'testimonials', props: { heading: 'What cafés say', items: [{ quote: 'Our customers noticed the difference in the first week, and waste is down 20%.', name: 'Priya Nair', detail: 'Kirkgate Kitchen, Leeds' }, { quote: 'Never late once in two years.', name: 'Tom Ashworth', detail: 'Northern Bloc Bakery' }] } },
            { id: 'faq', type: 'faq', props: { heading: 'Questions cafés ask', items: [{ q: 'Is there a minimum order?', a: '5kg a week.' }, { q: 'Do you lend equipment?', a: 'Yes, grinders on a 12-month order.' }, { q: 'How fast is delivery?', a: 'Within 48 hours of roasting.' }] } },
            { id: 'go', type: 'cta', props: { heading: 'Try us for a week', body: 'Free tasting box, no commitment.', button: { label: 'Get a wholesale quote', href: '/contact' } } },
        ] },
        { id: 'contact', slug: 'contact', title: 'Contact', seo: { title: null, description: 'Ask for a wholesale quote.' }, sections: [
            { id: 'c1', type: 'text', props: { heading: 'Ask for a quote', body: 'Email hello@willowbrook.example or call us.\n\nWe reply the same day.' } },
        ] },
    ],
    footer: { text: 'Willowbrook Coffee Ltd, 12 Mill Lane, Leeds.' },
};
const good = () => normaliseSiteDefinition(GOOD).definition;
const ctx: RenderContext = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: 'https://bemoreswan.com/report?site=7', creditUrl: 'https://bemoreswan.com' };
const h1Count = (html: string) => (html.match(/<h1[\s>]/g) || []).length;

console.log('\nThe gate');

check('a complete site passes untouched, with no warnings, and the gate is idempotent', () => {
    const { definition, warnings } = normaliseSiteDefinition(GOOD);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(normaliseSiteDefinition(definition).definition, definition);
    assert.strictEqual(definition.pages[0].sections[0].id, 'hero', 'existing ids are kept');
});

check('empty or broken input becomes a one-page starter that renders', () => {
    for (const raw of [null, undefined, 'x', 42, {}, { pages: 'nope' }]) {
        const { definition } = normaliseSiteDefinition(raw);
        assert.strictEqual(definition.pages.length, 1);
        assert.strictEqual(definition.pages[0].slug, '');
        assert.strictEqual(renderSitePage(definition, '/', ctx).status, 200);
    }
});

check('unknown sections and incomplete ones are dropped, with a reason', () => {
    const { definition, warnings } = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [
        { type: 'iframe', props: { src: 'https://evil.example' } },
        { type: 'hero', props: { headline: '' } },
        { type: 'steps', props: { items: [{ title: 'Only one' }] } },
        { type: 'text', props: { body: 'Kept.' } },
    ] }] });
    assert.deepStrictEqual(definition.pages[0].sections.map((s) => s.type), ['text']);
    assert.ok(warnings.some((w) => /unknown kind/.test(w)) && warnings.some((w) => /needs a headline/.test(w)) && warnings.some((w) => /at least two steps/.test(w)));
});

check('links: only https, mailto, tel, anchors and real pages', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'http://example.com', '//evil.example', 'https://user:pw@x.example', '/../etc', 'vbscript:x']) {
        assert.strictEqual(cleanHref(bad), null, bad);
    }
    for (const ok of ['https://x.example/a?b=1', 'mailto:jo@x.example', 'tel:+44 113 496 0000', '#how', '/', '/contact']) assert.ok(cleanHref(ok), ok);
    const { definition, warnings } = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [
        { type: 'hero', props: { headline: 'Hi there everyone', primaryCta: { label: 'Go', href: '/nowhere' } } },
        { type: 'cta', props: { heading: 'Act', button: { label: 'Click', href: 'javascript:alert(1)' } } },
    ] }] });
    const hero = definition.pages[0].sections[0];
    assert.ok(hero.type === 'hero' && hero.props.primaryCta === null, 'link to a missing page removed');
    assert.strictEqual(definition.pages[0].sections.length, 1, 'a CTA with no safe button is dropped');
    assert.ok(warnings.some((w) => w.includes('/nowhere')));
});

check('images need https and alt text, or they are left out', () => {
    const run = (image: unknown) => {
        const d = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Hello world here', image } }] }] }).definition;
        const s = d.pages[0].sections[0];
        return s.type === 'hero' ? s.props.image : 'wrong';
    };
    assert.strictEqual(run({ url: 'https://x.example/a.jpg', alt: '' }), null);
    assert.strictEqual(run({ url: 'http://x.example/a.jpg', alt: 'A cup' }), null);
    assert.deepStrictEqual(run({ url: 'https://x.example/a.jpg', alt: 'A cup' }), { url: 'https://x.example/a.jpg', alt: 'A cup' });
});

check('page addresses: cleaned, unique, never reserved; exactly one home, listed first', () => {
    assert.strictEqual(slugify('Our Services & Prices!'), 'our-services-and-prices');
    assert.strictEqual(slugify('Café Menu'), 'cafe-menu');
    const { definition } = normaliseSiteDefinition({ pages: [
        { title: 'About', slug: 'about' }, { title: 'About again', slug: 'about' }, { title: 'Sitemap', slug: 'sitemap.xml' },
        { title: 'Home', slug: '' }, { title: 'Another home', slug: '' },
    ] });
    assert.deepStrictEqual(definition.pages.map((p) => p.slug), ['', 'about', 'about-2', 'sitemap-xml', 'another-home']);
    const noHome = normaliseSiteDefinition({ pages: [{ title: 'Services', slug: 'services' }] }).definition;
    assert.strictEqual(noHome.pages[0].slug, '', 'with no home page, the first page becomes home');
});

check(`no plan cap: only the safety ceiling (${DEFAULT_MAX_PAGES}) holds, and it never mentions a plan`, () => {
    // Owner, 2026-10-31: no plan limits website pages. 7 pages used to be cut to the £29 plan's 5.
    assert.ok(DEFAULT_MAX_PAGES >= 100, 'the ceiling is a safety net, not a plan limit');
    const seven = Array.from({ length: 7 }, (_, i) => ({ title: `Page ${i + 1}`, slug: i ? `p${i}` : '' }));
    assert.strictEqual(normaliseSiteDefinition({ pages: seven }).definition.pages.length, 7);
    const pages = Array.from({ length: DEFAULT_MAX_PAGES + 2 }, (_, i) => ({ title: `Page ${i + 1}`, slug: i ? `p${i}` : '' }));
    const r = normaliseSiteDefinition({ pages });
    assert.strictEqual(r.definition.pages.length, DEFAULT_MAX_PAGES);
    assert.ok(r.warnings.some((w) => /A site can have up to \d+ pages/.test(w)));
    assert.ok(!r.warnings.some((w) => /plan/i.test(w)), 'the warning must not blame a plan');
});

check('navigation only lists real pages, once each', () => {
    const d = normaliseSiteDefinition({ ...GOOD, nav: [{ pageId: 'contact', label: 'Talk to us' }, { pageId: 'contact' }, { pageId: 'ghost' }] }).definition;
    assert.deepStrictEqual(d.nav, [{ label: 'Talk to us', pageId: 'contact' }]);
});

check('colours: an unreadable pair falls back to readable defaults; bad values are refused', () => {
    const r = normaliseSiteDefinition({ theme: { textColor: '#eeeeee', backgroundColor: '#ffffff', primaryColor: 'red; background:url(x)', font: 'Comic Sans', radius: '999px', logoUrl: 'http://x.example/logo.png' } });
    assert.ok(r.warnings.some((w) => /too hard to read/.test(w)));
    assert.ok(contrastRatio(r.definition.theme.textColor, r.definition.theme.backgroundColor) >= 4.5);
    assert.strictEqual(r.definition.theme.primaryColor, DEFAULT_THEME.primaryColor);
    assert.strictEqual(r.definition.theme.font, 'sans');
    assert.strictEqual(r.definition.theme.radius, 'medium');
    assert.strictEqual(r.definition.theme.logoUrl, null);
});

check('a testimonial needs the customer\'s name; a quote with none is dropped', () => {
    const r = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'testimonials', props: { items: [{ quote: 'Great!', name: '' }] } }] }] });
    assert.strictEqual(r.definition.pages[0].sections.length, 0);
    assert.ok(r.warnings.some((w) => /needs the customer's name/.test(w)));
});

check('control characters go, lengths are clamped', () => {
    const d = normaliseSiteDefinition({ pages: [{ title: 'Home\u0000\u0007', slug: '', sections: [{ type: 'hero', props: { headline: 'x'.repeat(500) } }] }] }).definition;
    assert.strictEqual(d.pages[0].title, 'Home');
    const s = d.pages[0].sections[0];
    assert.ok(s.type === 'hero' && s.props.headline.length === 120);
});

console.log('\nOperations');

check('every operation leaves the input untouched', () => {
    const d = deepFreeze(good());
    const ops = [
        { op: 'add_page', title: 'Menu' }, { op: 'remove_page', pageId: 'contact' },
        { op: 'add_section', pageId: 'home', section: { type: 'text', props: { body: 'Hi' } } },
        { op: 'update_section', pageId: 'home', sectionId: 'hero', props: { headline: 'New headline here' } },
        { op: 'move_section', pageId: 'home', sectionId: 'go', toIndex: 0 }, { op: 'set_theme', theme: { radius: 'large' } },
    ] as const;
    for (const op of ops) assert.strictEqual(applySiteOperation(d, op as never).ok, true, op.op);
});

check('add a page: gets an id and an address; refused at the plan cap with a sentence', () => {
    const r = applySiteOperation(good(), { op: 'add_page', title: 'Our Menu' });
    assert.ok(r.ok);
    if (!r.ok) return;
    const page = r.definition.pages.find((p) => p.title === 'Our Menu')!;
    assert.ok(page.id && page.slug === 'our-menu');
    const capped = applySiteOperation(good(), { op: 'add_page', title: 'Third' }, { maxPages: 2 });
    assert.ok(!capped.ok && /A site can have up to 2 pages/.test(capped.error) && !/plan/i.test(capped.error));
});

check('the home page cannot be removed; removing a page takes it out of the menu', () => {
    const r1 = applySiteOperation(good(), { op: 'remove_page', pageId: 'home' });
    assert.ok(!r1.ok && /home page/.test(r1.error));
    const withNav = normaliseSiteDefinition({ ...GOOD, nav: [{ pageId: 'home' }, { pageId: 'contact' }] }).definition;
    const r2 = applySiteOperation(withNav, { op: 'remove_page', pageId: 'contact' });
    assert.ok(r2.ok && r2.definition.nav.length === 1 && r2.definition.pages.length === 1);
});

check('sections: add at a position, update by merging, move, refuse an incomplete one', () => {
    const add = applySiteOperation(good(), { op: 'add_section', pageId: 'home', index: 1, section: { type: 'text', props: { heading: 'Our story', body: 'Since 2019.' } } });
    assert.ok(add.ok && add.definition.pages[0].sections[1].type === 'text' && add.definition.pages[0].sections[1].id);
    const bad = applySiteOperation(good(), { op: 'add_section', pageId: 'home', section: { type: 'cta', props: { heading: 'Act now' } } });
    assert.ok(!bad.ok && bad.error === 'Not saved — it needs a heading and a button.', !bad.ok ? bad.error : '');
    const upd = applySiteOperation(good(), { op: 'update_section', pageId: 'home', sectionId: 'hero', props: { headline: 'Coffee for Yorkshire cafés' } });
    assert.ok(upd.ok);
    if (upd.ok) {
        const h = upd.definition.pages[0].sections[0];
        assert.ok(h.type === 'hero' && h.props.headline === 'Coffee for Yorkshire cafés' && h.props.subheadline, 'other props kept');
    }
    const empty = applySiteOperation(good(), { op: 'update_section', pageId: 'home', sectionId: 'hero', props: { headline: '' } });
    assert.ok(!empty.ok);
    const mv = applySiteOperation(good(), { op: 'move_section', pageId: 'home', sectionId: 'go', toIndex: 0 });
    assert.ok(mv.ok && mv.definition.pages[0].sections[0].id === 'go');
});

check('page address changes: unique, and the home page keeps "/"', () => {
    const clash = applySiteOperation(normaliseSiteDefinition({ ...GOOD, pages: [...GOOD.pages, { id: 'about', slug: 'about', title: 'About' }] }).definition, { op: 'update_page', pageId: 'about', slug: 'contact' });
    assert.ok(!clash.ok && /already uses \/contact/.test(clash.error));
    const home = applySiteOperation(good(), { op: 'update_page', pageId: 'home', slug: 'welcome' });
    assert.ok(home.ok && home.definition.pages[0].slug === '');
});

check('an unreadable theme change is refused, not silently replaced', () => {
    const r = applySiteOperation(good(), { op: 'set_theme', theme: { textColor: '#fefefe' } });
    assert.ok(!r.ok && /too hard to read together, so nothing was changed/.test(r.error));
});

check('stale ids are refused in words', () => {
    assert.deepStrictEqual(applySiteOperation(good(), { op: 'remove_page', pageId: 'gone' }), { ok: false, error: 'That page no longer exists.' });
    assert.deepStrictEqual(applySiteOperation(good(), { op: 'remove_section', pageId: 'home', sectionId: 'gone' }), { ok: false, error: 'That section no longer exists.' });
});

console.log('\nRendering');

check('exactly one <h1> on every page: the first hero, or the page title when there is none', () => {
    const d = good();
    assert.strictEqual(h1Count(renderSitePage(d, '/', ctx).html), 1);
    assert.strictEqual(h1Count(renderSitePage(d, '/contact', ctx).html), 1);
    assert.match(renderSitePage(d, '/contact', ctx).html, /<h1>Contact<\/h1>/);
    const twoHeroes = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [
        { type: 'hero', props: { headline: 'First hero here' } }, { type: 'hero', props: { headline: 'Second hero here' } }] }] }).definition;
    const html = renderSitePage(twoHeroes, '/', ctx).html;
    assert.strictEqual(h1Count(html), 1);
    assert.match(html, /<h1>First hero here<\/h1>/);
});

check('nothing typed becomes markup — text, attributes and structured data are all escaped', () => {
    const evil = '<img src=x onerror=alert(1)>"\'</script>';
    const d = normaliseSiteDefinition({
        settings: { siteName: evil, description: evil },
        pages: [{ title: 'Home', slug: '', seo: { title: evil, description: evil }, sections: [
            { type: 'hero', props: { headline: evil, subheadline: evil, primaryCta: { label: evil, href: 'https://x.example/"onmouseover="alert(1)' } } },
            { type: 'faq', props: { items: [{ q: evil, a: evil }] } },
        ] }],
        footer: { text: evil },
    }).definition;
    const html = renderSitePage(d, '/', ctx).html;
    assert.ok(!html.includes('<img src=x'), 'no raw tag');
    assert.ok(!/ on[a-z]+="/i.test(html), 'no event-handler attribute');
    assert.strictEqual((html.match(/<\/script>/g) || []).length, (html.match(/<script type="application\/ld\+json">/g) || []).length, 'no script closed early');
    assert.ok(!/<script(?! type="application\/ld\+json")/.test(html), 'the only scripts are JSON-LD data');
    assert.strictEqual(esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
    assert.ok(!jsonLd({ a: '</script>' }).includes('</'));
});

check('a page carries its title, description, canonical, share tags, language and viewport', () => {
    const html = renderSitePage(good(), '/', ctx).html;
    assert.match(html, /<title>Wholesale coffee for Yorkshire cafés \| Willowbrook<\/title>/);
    assert.match(html, /<meta name="description" content="Fresh-roasted coffee for independent cafés/);
    assert.match(html, /<link rel="canonical" href="https:\/\/willowbrook\.bemoreswan\.site\/">/);
    assert.match(html, /<meta property="og:url" content="https:\/\/willowbrook\.bemoreswan\.site\/">/);
    assert.match(html, /<html lang="en-GB">/);
    assert.match(html, /<meta name="viewport"/);
    assert.ok(!html.includes('noindex'));
    assert.match(renderSitePage(good(), '/contact', ctx).html, /<title>Contact \| Willowbrook Coffee<\/title>/);
});

check('structured data: the business on the home page; FAQPage wherever there are questions', () => {
    const home = renderSitePage(good(), '/', ctx).html;
    const blocks = [...home.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    assert.deepStrictEqual(blocks.map((b) => b['@type']), ['LocalBusiness', 'FAQPage']);
    assert.strictEqual(blocks[0].address.addressLocality, 'Leeds');
    assert.strictEqual(blocks[1].mainEntity.length, 3);
    assert.ok(!renderSitePage(good(), '/contact', ctx).html.includes('ld+json'), 'the business block is on the home page only');
});

check('every footer can report the site; the credit is optional', () => {
    const html = renderSitePage(good(), '/', ctx).html;
    assert.match(html, /<a href="https:\/\/bemoreswan\.com\/report\?site=7" rel="nofollow">Report this site<\/a>/);
    assert.match(html, /Made with Be More Swan/);
    assert.ok(!renderSitePage(good(), '/', { ...ctx, creditUrl: null }).html.includes('Made with Be More Swan'));
    assert.match(renderSitePage(good(), '/', { ...ctx, creditUrl: null }).html, /Report this site/);
});

check('a draft preview is never indexed and says it is not live', () => {
    const html = renderSitePage(good(), '/', { ...ctx, preview: true }).html;
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.ok(!html.includes('rel="canonical"'));
    assert.match(html, /Preview — this version is not live yet\./);
    assert.strictEqual(renderRobots(ctx.origin, true), 'User-agent: *\nDisallow: /\n');
    assert.match(renderRobots(ctx.origin, false), /Sitemap: https:\/\/willowbrook\.bemoreswan\.site\/sitemap\.xml/);
});

check('an unknown address is a real 404 in the site\'s own look, never indexed', () => {
    const r = renderSitePage(good(), '/nope', ctx);
    assert.strictEqual(r.status, 404);
    assert.match(r.html, /Page not found/);
    assert.match(r.html, /noindex/);
    assert.strictEqual(renderSitePage(good(), '/contact/', ctx).status, 200, 'a trailing slash still finds the page');
});

check('the sitemap lists every page', () => {
    const xml = renderSitemap(good(), ctx.origin);
    assert.match(xml, /<loc>https:\/\/willowbrook\.bemoreswan\.site\/<\/loc>/);
    assert.match(xml, /<loc>https:\/\/willowbrook\.bemoreswan\.site\/contact<\/loc>/);
});

check('the stylesheet uses the theme, and the button label is readable on the button', () => {
    const html = renderSitePage(good(), '/', ctx).html;
    assert.match(html, /--p:#2d6a4f;--t:#1f2937;--b:#ffffff;--ink:#[0-9a-f]{6}/i);
    const ink = /--ink:(#[0-9a-f]{6})/i.exec(html)![1];
    assert.ok(contrastRatio(ink, '#2d6a4f') >= 4.5, `ink ${ink}`);
});

console.log('\nOur own critic');

check('a site we render passes the Mystery Shopper\'s code checks on the basics', () => {
    const page = extractSitePage(renderSitePage(good(), '/', ctx).html, `${ctx.origin}/`);
    const results = Object.fromEntries(runDeterministicChecks(page).map((c) => [c.id, c.result]));
    for (const id of ['one_h1', 'h1_length', 'has_subheadline', 'has_primary_cta', 'cta_outcome', 'proof_present', 'proof_quantified',
        'title_ok', 'description_ok', 'schema_present', 'schema_entity', 'faq_present', 'indexable', 'https', 'mobile_viewport', 'images_alt', 'lang_set']) {
        assert.strictEqual(results[id], 'pass', `${id}: ${results[id]}`);
    }
});

check('"What should a visitor do?" offers the Mystery Shopper\'s choices, free trial included (prod 2026-10-26)', () => {
    // A workspace with a free trial couldn't point its site at it while the Mystery Shopper checked for it.
    const field = (schemas as any).website_assistant.flatMap((st: any) => st.fields).find((f: any) => f.key === 'siteGoal');
    assert.deepStrictEqual(field.options.map((o: any) => o.label), CONVERSION_GOALS.map((g) => g.label));
});

console.log(`\n${passed}/${total} passed`);
