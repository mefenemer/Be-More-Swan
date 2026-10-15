// tests/site-menu.test.ts
// The menu / price list section: groups the owner names, filled with Business Information products,
// drawn as name · price lines. Names, prices, descriptions and lengths are read from Business
// Information when the page is drawn (site-shop.ts loadSiteProducts) — never stored in the site.
//
// Run:  npx tsx tests/site-menu.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS, normaliseSiteDefinition, type MenuProps, type SiteDefinition } from '../src/utils/site-definition';
import { formatDuration, renderSitePage, type SiteRenderProduct } from '../src/utils/site-render';
import { siteFromDraftReply } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const gate = (props: Record<string, unknown>) => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Bistro' },
    pages: [{ title: 'Home', slug: '', sections: [{ id: 'm1', type: 'menu', props }] }],
});
const menuOf = (d: SiteDefinition) => d.pages[0].sections.find((s) => s.type === 'menu')?.props as MenuProps | undefined;

const products: Record<number, SiteRenderProduct> = {
    1: { id: 1, name: 'Soup of the day', description: 'With sourdough.', price: '£6.50', buyPence: 650, imageAssetId: null },
    2: { id: 2, name: 'Fish & chips', description: null, price: '£15', buyPence: 1500, imageAssetId: null },
    3: { id: 3, name: 'Cut & finish', description: 'Wash, cut and blow-dry.', price: 'from £45', buyPence: null, imageAssetId: null, durationMinutes: 90 },
    4: { id: 4, name: 'Fringe trim', description: null, price: null, buyPence: null, imageAssetId: null, durationMinutes: 15 },
};
const live = { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, products };

console.log('\nThe gate');

check('keeps groups in order, drops empty ones, defaults descriptions on and lengths off', () => {
    const r = gate({ heading: 'Menu', groups: [{ title: 'Starters', productIds: [1] }, { title: 'Empty', productIds: [] }, { title: 'Mains', productIds: ['2'] }] });
    const m = menuOf(r.definition)!;
    assert.deepStrictEqual(m.groups, [{ title: 'Starters', productIds: [1] }, { title: 'Mains', productIds: [2] }]);
    assert.strictEqual(m.showDescriptions, true);
    assert.strictEqual(m.showDurations, false);
});
check('each product appears once across the whole menu', () => {
    const m = menuOf(gate({ groups: [{ title: 'A', productIds: [1, 2, 1] }, { title: 'B', productIds: [2, 3] }] }).definition)!;
    assert.deepStrictEqual(m.groups.map((g) => g.productIds), [[1, 2], [3]]);
});
check('a menu with nothing in it is refused in words', () => {
    const r = gate({ groups: [{ title: 'Starters', productIds: [] }] });
    assert.strictEqual(menuOf(r.definition), undefined);
    assert.ok(r.warnings.some((w) => /menu was left out/.test(w)));
});
check('the item and group caps hold, with a warning', () => {
    const many = Array.from({ length: LIMITS.menuItems + 5 }, (_, i) => i + 1);
    const r = gate({ groups: [{ title: 'All', productIds: many }] });
    assert.strictEqual(menuOf(r.definition)!.groups[0].productIds.length, LIMITS.menuItems);
    assert.ok(r.warnings.some((w) => /up to 100 items/.test(w)));
    const g = gate({ groups: Array.from({ length: LIMITS.menuGroups + 2 }, (_, i) => ({ title: `G${i}`, productIds: [i + 1] })) });
    assert.strictEqual(menuOf(g.definition)!.groups.length, LIMITS.menuGroups);
});
check('prices typed into a menu are not kept — there is nowhere to put them', () => {
    const m = menuOf(gate({ groups: [{ title: 'A', productIds: [1], price: 100 }], items: [{ name: 'X', price: 5 }] }).definition)!;
    assert.deepStrictEqual(Object.keys(m).sort(), ['groups', 'heading', 'intro', 'note', 'showDescriptions', 'showDurations']);
    assert.deepStrictEqual(Object.keys(m.groups[0]).sort(), ['productIds', 'title']);
});

console.log('\nOn the page');

check('draws group headings and name · price lines from Business Information', () => {
    const d = gate({ heading: 'Menu', groups: [{ title: 'Starters', productIds: [1] }, { title: 'Mains', productIds: [2] }], note: 'Tell us about any allergies.' }).definition;
    const html = renderSitePage(d, '/', live).html;
    assert.ok(html.includes('<h3>Starters</h3><ul class="menu"><li><div class="mi"><span class="mn">Soup of the day</span><span class="ml" aria-hidden="true"></span><span class="mp">£6.50</span></div><p class="md">With sourdough.</p></li></ul>'));
    assert.ok(html.includes('<span class="mn">Fish &amp; chips</span>'));
    assert.ok(html.includes('Tell us about any allergies.'));
    assert.ok(!html.includes('_buy') && !html.includes('Buy now'));
});
check('lengths when asked, descriptions off when asked, no price when there is none', () => {
    const d = gate({ groups: [{ title: null, productIds: [3, 4] }], showDurations: true, showDescriptions: false }).definition;
    const html = renderSitePage(d, '/', live).html;
    assert.ok(html.includes('Cut &amp; finish <span class="mt">1 hr 30 min</span>'));
    assert.ok(html.includes('<span class="mp">from £45</span>'));
    assert.ok(html.includes('Fringe trim <span class="mt">15 min</span></span><span class="ml" aria-hidden="true"></span></div>'));
    assert.ok(!html.includes('<p class="md">'));
    assert.ok(!html.includes('<h3>'));
});
check('a product archived since is skipped; all gone → absent live, explained in the preview', () => {
    const d = gate({ groups: [{ title: 'Starters', productIds: [1, 99] }] }).definition;
    assert.ok(renderSitePage(d, '/', live).html.includes('Soup of the day'));
    const gone = gate({ groups: [{ title: 'Starters', productIds: [99] }] }).definition;
    assert.ok(!renderSitePage(gone, '/', live).html.includes('id="m1"'));
    assert.ok(renderSitePage(gone, '/', { ...live, preview: true }).html.includes('archived or removed in Business Information'));
});
check('the columns look applies to the groups', () => {
    const d = normaliseSiteDefinition({ settings: { siteName: 'B' }, pages: [{ title: 'Home', slug: '', sections: [{ id: 'm1', type: 'menu', look: { columns: 2 }, props: { groups: [{ title: 'A', productIds: [1] }, { title: 'B', productIds: [2] }] } }] }] }).definition;
    assert.ok(renderSitePage(d, '/', live).html.includes('<div class="grid c2"><div><h3>A</h3>'));
});
check('search data: fixed prices become Offers; "from" prices are shown, not claimed', () => {
    const d = gate({ groups: [{ title: 'A', productIds: [1, 3] }] }).definition;
    const html = renderSitePage(d, '/', live).html;
    assert.ok(html.includes('"name":"Soup of the day"') && html.includes('"price":"6.50"'));
    const ld = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const cut = ld.find((x) => x['@type'] === 'Product' && x.name === 'Cut & finish');
    assert.ok(cut && !('offers' in cut));
});
check('lengths read as people say them', () => {
    assert.deepStrictEqual([15, 45, 60, 90, 125].map(formatDuration), ['15 min', '45 min', '1 hr', '1 hr 30 min', '2 hr 5 min']);
});

console.log('\nDrafts and wiring');

check('a whole-site draft never lists products (prices are the owner\'s)', () => {
    const current = gate({ groups: [{ title: 'A', productIds: [1] }] }).definition;
    const reply = ({ pages: [{ title: 'Home', slug: '', sections: [
        { type: 'hero', props: { headline: 'Welcome' } },
        { type: 'menu', props: { groups: [{ title: 'Mains', productIds: [2] }] } },
    ] }] });
    const d = siteFromDraftReply(reply, current, 5);
    assert.ok(d && !d.definition.pages.some((p) => p.sections.some((s) => s.type === 'menu')));
});
check('live sites load products for a menu; editor and chat know the section', () => {
    assert.ok(read('netlify/functions/site-serve.ts').includes("s.type === 'menu'"));
    assert.ok(read('src/utils/site-shop.ts').includes("s.type === 'menu' ? s.props.groups.flatMap((g) => g.productIds)"));
    const editor = read('src/components/assistant-site-editor.js');
    assert.ok(editor.includes("menu: 'Menu / price list'") && editor.includes("kind: 'menuGroups'") && editor.includes('data-menu-group-add'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('menu {heading, intro, groups:[{title, productIds:'));
});

console.log(`\n${passed}/${total} passed\n`);
