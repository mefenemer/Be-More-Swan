// tests/site-product-page.test.ts
// Online shop Phase 1 (FR#35, docs/online-shop-review-plan.md §6): each product's own page on a hosted
// site, /shop/<id>-<name> (src/utils/site-product-page.ts, site-render.ts renderSiteProduct).
//
// Run:  npx tsx tests/site-product-page.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { productHomePage, productPagePath, productRoute, productSections, productSlug } from '../src/utils/site-product-page';
import { normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitemap, renderSitePage, renderSiteProduct } from '../src/utils/site-render';
import { safeBackPath } from '../src/utils/site-forms';
import type { SiteProduct } from '../src/utils/site-shop';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const site = (productIds: number[]): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee' },
    pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Fresh coffee' } }] },
        { title: 'Shop', slug: 'shop', sections: [{ type: 'products', props: { heading: 'Our coffee', productIds, buyLabel: 'Buy a bag' } }] },
    ],
}).definition;
const BLEND: SiteProduct = { id: 11, name: 'House Blend (250g)', description: 'Our everyday coffee.\n\nRoasted on Mondays.', price: '£12.50', buyPence: 1250, imageAssetId: null };
const live = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };

console.log('\nAddresses');

check('the address carries the id and a readable name', () => {
    assert.strictEqual(productSlug('House Blend (250g)!'), 'house-blend-250g');
    assert.strictEqual(productSlug('Café & Crème'), 'cafe-and-creme');
    assert.strictEqual(productSlug('!!!'), 'item');
    assert.ok(productSlug('x'.repeat(200)).length <= 60);
    assert.strictEqual(productPagePath(BLEND), '/shop/11-house-blend-250g');
});

check('only /shop/<id>(-<slug>) is a product route', () => {
    assert.deepStrictEqual(productRoute('/shop/11-house-blend-250g'), { id: 11, slug: 'house-blend-250g' });
    assert.deepStrictEqual(productRoute('/shop/11'), { id: 11, slug: '' });
    assert.deepStrictEqual(productRoute('/shop/11-old-name/'), { id: 11, slug: 'old-name' });
    assert.deepStrictEqual(productRoute('/shop/11-House-Blend'), { id: 11, slug: 'House-Blend' }, 'capitals: matched, then 301 to the lowercase address');
    for (const no of ['/shop', '/shop/', '/shop/abc', '/shop/0', '/shop/11/x', '/shops/11', '/shop/11-a b']) assert.strictEqual(productRoute(no), null, no);
});

check('a product has a page only while a products section on the site offers it', () => {
    const d = site([11, 12]);
    const sections = productSections(d);
    assert.deepStrictEqual([...sections.keys()], [11, 12]);
    assert.strictEqual(sections.get(11), d.pages[1].sections[0].id);
    assert.deepStrictEqual(productHomePage(d, 11), { path: '/shop', title: 'Shop', id: d.pages[1].id });
    assert.strictEqual(renderSiteProduct(site([12]), { ...live, canSell: true }, BLEND), null, 'not offered → no page');
});

console.log('\nThe page');

check('picture-less page: name, price, description, and the same Buy form as the card (back to this page)', () => {
    const d = site([11]);
    const html = renderSiteProduct(d, { ...live, canSell: true }, BLEND)!;
    assert.ok(html.includes('<h1>House Blend (250g)</h1>'));
    assert.ok(html.includes('£12.50') && html.includes('Roasted on Mondays.'));
    assert.ok(html.includes(`name="_s" value="${d.pages[1].sections[0].id}"`) && html.includes('name="_pid" value="11"') && html.includes('name="_v" value="1250"'));
    assert.ok(html.includes('name="_p" value="/shop/11-house-blend-250g"'), 'Cancel at Stripe returns to the product page');
    assert.ok(html.includes('Buy a bag'), 'the section\'s own button words');
    assert.ok(html.includes('/delivery-returns'), 'Delivery & returns before paying');
    assert.ok(html.includes('<link rel="canonical" href="https://willowbrook.bemoreswan.site/shop/11-house-blend-250g">'));
    assert.ok(html.includes('"@type":"Product"') && html.includes('"price":"12.50"'));
    assert.ok(html.includes('← Shop'), 'back to the page that sells it');
});

check('sold out: no Buy form, Sold out shown; not selling yet: no Buy form either', () => {
    const d = site([11]);
    const sold = renderSiteProduct(d, { ...live, canSell: true }, { ...BLEND, stock: 0 })!;
    assert.ok(sold.includes('data-sold-out') && !sold.includes('name="_pid"') && sold.includes('OutOfStock'));
    assert.ok(!sold.includes('/delivery-returns'), 'no terms link without a Buy button');
    const notYet = renderSiteProduct(d, { ...live, canSell: false }, BLEND)!;
    assert.ok(!notYet.includes('name="_pid"') && notYet.includes('£12.50'));
});

check('live product cards link to the page; the editor preview doesn\'t', () => {
    const d = site([11]);
    const livePage = renderSitePage(d, '/shop', { ...live, canSell: true, products: { 11: BLEND } }).html;
    assert.ok(livePage.includes('href="/shop/11-house-blend-250g" data-product-link'));
    const preview = renderSitePage(d, '/shop', { ...live, preview: true, canSell: true, products: { 11: BLEND } }).html;
    assert.ok(!preview.includes('data-product-link'));
});

check('the sitemap lists product pages', () => {
    const xml = renderSitemap(site([11]), live.origin, [], [], [], ['/shop/11-house-blend-250g']);
    assert.ok(xml.includes('<loc>https://willowbrook.bemoreswan.site/shop/11-house-blend-250g</loc>'));
});

check('a Buy from a product page returns there; any other made-up path still falls back home', () => {
    const d = site([11]);
    assert.strictEqual(safeBackPath(d, '/shop/11-house-blend-250g'), '/shop/11-house-blend-250g');
    assert.strictEqual(safeBackPath(d, '/shop/99-not-on-the-site'), '/');
    assert.strictEqual(safeBackPath(d, '//evil.example'), '/');
    assert.strictEqual(safeBackPath(d, '/shop'), '/shop');
});

check('served by site-serve: offered products only, old names 301 to the current one, sitemap included', () => {
    const serve = read('netlify/functions/site-serve.ts');
    assert.ok(serve.includes('if (pr && productSections(definition).has(pr.id))'));
    assert.ok(serve.includes("if (canonical !== path.replace(/\\/$/, '')) return { statusCode: 301, headers: { Location: `${canonical}${q ? `?${q}` : ''}`"), 'the 301 keeps the query');
    assert.ok(serve.includes('renderSiteProduct(definition, { ...ctx, canSell: await canSell(db, site.organisationId)'));
    assert.ok(serve.indexOf('const pr = productRoute(path);') < serve.indexOf('const moved = redirectFor(definition, path);'), 'before old-address redirects');
    assert.ok(serve.includes('productPaths) };'), 'sitemap gets the product pages');
});

console.log(`\n${passed}/${total} passed`);
