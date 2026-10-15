// tests/site-layout.test.ts
// Sites that don't follow the standard structure: one-page sites (structure + combine_pages), pages
// hidden from the menu, and how each section looks (background, columns, a picture beside text) —
// all closed choices through the one gate (site-definition.ts) and drawn by site-render.ts.
//
// Run:  npx tsx tests/site-layout.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySiteOperation, assetIdsIn, cleanLook, menuOf, normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { siteFromDraftReply } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const ctx = { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };

const site = (): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee' },
    pages: [
        { title: 'Home', slug: '', sections: [{ id: 'hero1', type: 'hero', props: { headline: 'Fresh coffee', primaryCta: { label: 'See prices', href: '/prices' } } }] },
        { title: 'Prices', slug: 'prices', sections: [{ id: 'p1s', type: 'features', props: { heading: 'Prices', items: [{ title: 'Beans', body: '£12' }] } }] },
        { title: 'Contact', slug: 'contact', sections: [{ id: 'c1s', type: 'text', props: { heading: 'Find us', body: 'Leeds.' } }, { id: 'c2s', type: 'cta', props: { heading: 'Order', button: { label: 'See prices', href: '/prices' } } }] },
    ],
}).definition;

console.log('\nOne page');

check('combining moves every page onto the home page in order, labels each page, turns links into jumps', () => {
    const r = applySiteOperation(site(), { op: 'combine_pages' }, { maxPages: 5 });
    assert.ok(r.ok);
    if (!r.ok) return;
    const d = r.definition;
    assert.strictEqual(d.pages.length, 1);
    assert.strictEqual(d.structure, 'one_page');
    assert.deepStrictEqual(d.pages[0].sections.map((s) => s.id), ['hero1', 'p1s', 'c1s', 'c2s']);
    assert.deepStrictEqual(d.pages[0].sections.map((s) => s.look?.menuLabel ?? null), [null, 'Prices', 'Contact', null]);
    const hero = d.pages[0].sections[0].props as { primaryCta: { href: string } };
    assert.strictEqual(hero.primaryCta.href, '#p1s', 'a link to the Prices page now jumps to its section');
    assert.strictEqual((d.pages[0].sections[3].props as { button: { href: string } }).button.href, '#p1s', 'and the button is kept, not dropped');
    assert.deepStrictEqual(menuOf(d).map((m) => [m.label, m.path]), [['Prices', '#p1s'], ['Contact', '#c1s']]);
});

check('combining is refused when the sections would not fit on one page, and on a one-page site already', () => {
    const many = normaliseSiteDefinition({ pages: [
        { title: 'Home', slug: '', sections: Array.from({ length: 12 }, (_, i) => ({ type: 'text', props: { body: `a${i}` } })) },
        { title: 'More', slug: 'more', sections: Array.from({ length: 12 }, (_, i) => ({ type: 'text', props: { body: `b${i}` } })) },
    ] }).definition;
    const r = applySiteOperation(many, { op: 'combine_pages' }, { maxPages: 5 });
    assert.ok(!r.ok && /up to 20 sections.*24.*Remove 4/.test(r.error));
    const once = applySiteOperation(site(), { op: 'combine_pages' }, { maxPages: 5 });
    assert.ok(once.ok && !applySiteOperation(once.definition, { op: 'combine_pages' }, { maxPages: 5 }).ok);
});

check('the one-page menu jumps down the page; from another page it jumps home first', () => {
    const d = applySiteOperation(site(), { op: 'set_structure', structure: 'one_page' }, { maxPages: 5 });
    assert.ok(d.ok);
    if (!d.ok) return;
    const labelled = applySiteOperation(d.definition, { op: 'update_section', pageId: d.definition.pages[0].id, sectionId: 'hero1', look: { menuLabel: 'Welcome' } }, { maxPages: 5 });
    assert.ok(labelled.ok);
    if (!labelled.ok) return;
    const home = renderSitePage(labelled.definition, '/', ctx).html;
    assert.ok(home.includes('<a href="#hero1">Welcome</a>'));
    const other = renderSitePage(labelled.definition, '/prices', ctx).html;
    assert.ok(other.includes('<a href="/#hero1">Welcome</a>'), 'from /prices, back to the home page section');
    assert.ok(home.includes('<a href="/prices">Prices</a>'), 'pages not hidden still follow the jumps');
});

check('an AI draft keeps a one-page site one page', () => {
    const one = applySiteOperation(site(), { op: 'combine_pages' }, { maxPages: 5 });
    assert.ok(one.ok);
    if (!one.ok) return;
    const r = siteFromDraftReply({ pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Coffee' } }] },
        { title: 'About', slug: 'about', sections: [{ type: 'text', props: { body: 'Us.' } }] },
    ] }, one.definition, 5)!;
    assert.strictEqual(r.definition.pages.length, 1);
    assert.strictEqual(r.definition.structure, 'one_page');
    assert.ok(r.definition.pages[0].sections.some((s) => s.look?.menuLabel === 'About'));
});

console.log('\nHidden pages');

check('a hidden page leaves the menu but keeps its address; the home page cannot be hidden', () => {
    const d = site();
    const contact = d.pages.find((p) => p.slug === 'contact')!;
    const r = applySiteOperation(d, { op: 'update_page', pageId: contact.id, hideFromMenu: true }, { maxPages: 5 });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepStrictEqual(menuOf(r.definition).map((m) => m.label), ['Home', 'Prices']);
    assert.strictEqual(renderSitePage(r.definition, '/contact', ctx).status, 200);
    const home = applySiteOperation(d, { op: 'update_page', pageId: d.pages[0].id, hideFromMenu: true }, { maxPages: 5 });
    assert.ok(!home.ok && /always in the menu/.test(home.error));
    assert.strictEqual(normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', hideFromMenu: true, sections: [] }] }).definition.pages[0].hideFromMenu, false);
});

console.log('\nHow a section looks');

check('the look is a closed set: unknown values fall back, columns only for grid sections, no background for the opening section', () => {
    assert.deepStrictEqual(cleanLook({ background: 'red; display:none', columns: 7, menuLabel: '  Prices  ' }, 'features'), { background: 'auto', columns: 'auto', menuLabel: 'Prices' });
    assert.deepStrictEqual(cleanLook({ background: 'brand', columns: 3 }, 'features'), { background: 'brand', columns: 3, menuLabel: null });
    assert.strictEqual(cleanLook({ columns: 3 }, 'text').columns, 'auto');
    assert.strictEqual(cleanLook({ background: 'brand' }, 'hero').background, 'auto');
});

check('backgrounds and columns are drawn; a text picture sits beside the words and is ownership-checked', () => {
    const d = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [
        { type: 'features', props: { items: [{ title: 'A', body: 'b' }] }, look: { background: 'brand', columns: 3 } },
        { type: 'text', props: { body: 'Hello.', image: { assetId: 8, alt: 'The shop' }, imageSide: 'left' }, look: { background: 'plain' } },
        { type: 'text', props: { body: 'Soft.' }, look: { background: 'soft' } },
    ] }] }).definition;
    const html = renderSitePage(d, '/', { ...ctx, assetUrl: (id) => `https://bemoreswan.com/m?a=${id}` }).html;
    assert.ok(/<section class="band" id="[^"]+"><div class="w"><div class="grid c3">/.test(html));
    assert.ok(/<section id="[^"]+"><div class="w tx left"><img src="https:\/\/bemoreswan.com\/m\?a=8" alt="The shop"/.test(html));
    assert.ok(/<section class="alt" id="[^"]+"><div class="w n"><p>Soft\.<\/p>/.test(html));
    assert.ok(html.includes('.grid.c3{grid-template-columns') && html.includes('.band{background:var(--p)'));
    assert.deepStrictEqual(assetIdsIn(d), [8]);
});

check('editor and chat offer the options', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('function structureCard()') && ed.includes("{ op: 'combine_pages' }") && ed.includes('data-site-page-hidden') && ed.includes('function lookHtml(e)'));
    assert.ok(ed.includes("op: 'update_section', pageId: ed.pageId, sectionId: ed.sectionId, props, look"));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('{"op":"combine_pages"}') && chat.includes('"hideFromMenu":true|false') && chat.includes('"menuLabel":"..."|null'));
    assert.ok(read('netlify/functions/sites.ts').includes("'set_structure', 'combine_pages'"));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("combine_pages: () => 'Combine every page into one page'"));
});

console.log(`\n${passed}/${total} passed`);
