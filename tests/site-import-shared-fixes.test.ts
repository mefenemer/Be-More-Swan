// tests/site-import-shared-fixes.test.ts
// The remaining shared import fixes from docs/site-import-platforms/SUMMARY.md (2026-11-09):
//   1. framework picture routes unwrapped; a shell page's words read from its framework page data
//   2. srcset addresses with commas
//   3. closed (empty) accordion / tab panels filled from page data; icon-only buttons; phone drawers
//   4. .html addresses; tracking parameters; old file-style addresses forward
//   5. WooCommerce shops built with Elementor get both adapters
//   6. every product from a shop's own feed (Shopify, WooCommerce)
//   7. one-page sites: menu jumps become a one-page hosted site
//
// Run:  npx tsx tests/site-import-shared-fixes.test.ts

import assert from 'node:assert';
import * as cheerio from 'cheerio';
import { fullSizeImageUrl, largestFromSrcset, readImportPage, unwrapImageRoute, withoutTracking } from '../src/utils/site-extract';
import { expandThinPage, fillClosedPanels, pageDataBlobs, proseFromData, removePhoneDrawers, spliceStreamed } from '../src/utils/site-page-data';
import { priceWithCurrency, readShopifyFeed, readWooFeed, shopFeedUrl, shopifyCurrency } from '../src/utils/site-shop-feeds';
import { adapterFor } from '../src/utils/site-builders';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { normaliseSiteDefinition, redirectFor } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const current = () => starterSite({ name: 'Shared Co', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@a.example' }, themeFromBrandKit(null));
const texts = (html: string, url = 'https://x.example/') => readImportPage(html, url).blocks.filter((b) => 'text' in b).map((b) => (b as { text: string }).text);
const words = (n: number, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

async function main() {
    console.log('1. Framework pages');

    await check('picture routes give the picture they serve: Next.js, Vercel, Netlify, Astro, Nuxt IPX, Cloudflare', () => {
        assert.strictEqual(unwrapImageRoute('https://s.example/_next/image?url=%2Fa.jpg&w=640&q=75'), 'https://s.example/a.jpg');
        assert.strictEqual(unwrapImageRoute('https://s.example/_vercel/image?url=https%3A%2F%2Fcdn.example%2Fb.png&w=1'), 'https://cdn.example/b.png');
        assert.strictEqual(unwrapImageRoute('https://s.example/.netlify/images?url=/c.webp&w=300'), 'https://s.example/c.webp');
        assert.strictEqual(unwrapImageRoute('https://s.example/_image?href=%2F_astro%2Fd.jpg&w=400'), 'https://s.example/_astro/d.jpg');
        assert.strictEqual(unwrapImageRoute('https://s.example/_ipx/w_640&f_webp/images/e.jpg'), 'https://s.example/images/e.jpg');
        assert.strictEqual(unwrapImageRoute('https://s.example/cdn-cgi/image/width=400,quality=80/img/f.png'), 'https://s.example/img/f.png');
        assert.strictEqual(unwrapImageRoute('https://s.example/images/plain.jpg'), null);
        assert.strictEqual(fullSizeImageUrl('https://s.example/_next/image?url=%2Fa.jpg&w=640'), 'https://s.example/a.jpg');
    });

    await check('streamed Suspense content goes where the browser would put it', () => {
        const $ = cheerio.load('<main><template id="B:0"></template><p>Loading…</p><!--/$--></main><div hidden id="S:0"><h2>Reviews</h2><p>Lovely service.</p></div>');
        spliceStreamed($);
        assert.ok($('main').text().includes('Lovely service.') && !$('main').text().includes('Loading'));
    });

    const nextShell = `<html><head></head><body><div id="__next"><main><p>Loading…</p></main></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { page: { title: 'Riverside Bakes', intro: 'Sourdough and pastries baked every morning in our little riverside kitchen.', slug: 'home', imageUrl: 'https://x/y.jpg', sections: [{ heading: 'Our story', body: 'We started baking for friends and family and never stopped, one loaf at a time.' }] } } } })}</script></body></html>`;

    await check('a Next.js shell reads its words from __NEXT_DATA__: headings and paragraphs, never ids, slugs or addresses', () => {
        const t = texts(nextShell);
        assert.ok(t.includes('Riverside Bakes') && t.includes('Our story'), t.join(' | '));
        assert.ok(t.some((x) => x.startsWith('Sourdough and pastries')) && t.some((x) => x.startsWith('We started baking')));
        assert.ok(!t.some((x) => /^home$|https:\/\/x\/y\.jpg/.test(x)));
        assert.ok(!t.includes('Loading…'));
    });

    await check('the RSC payload, SvelteKit and Nuxt data are read too; a page the server drew is left alone', () => {
        const flight = `<html><body><main></main><script>self.__next_f.push([1,${JSON.stringify(`3:["$","div",null,{"children":[{"title":"Garden Rooms"},{"description":"Insulated garden offices built to order across Kent and Sussex."}]}]\n`)}])</script></body></html>`;
        assert.ok(texts(flight).some((x) => x.startsWith('Insulated garden offices')));
        const svelte = `<html><body><main></main><script type="application/json" data-sveltekit-fetched data-url="/api/page">${JSON.stringify({ status: 200, body: JSON.stringify({ heading: 'Yoga by the Sea', text: 'Small classes on the beach every Saturday morning, all levels welcome.' }) })}</script></body></html>`;
        assert.ok(texts(svelte).some((x) => x.startsWith('Small classes on the beach')));
        const nuxt = `<html><body><main></main><script id="__NUXT_DATA__" type="application/json">${JSON.stringify([{ title: 'Kiln Pottery', description: 'Wheel-thrown stoneware made in our studio in the Peak District.' }])}</script></body></html>`;
        assert.ok(texts(nuxt).some((x) => x.startsWith('Wheel-thrown stoneware')));
        const drawn = `<html><body><main><h1>Full page</h1><p>${words(60)}</p></main>${nextShell.match(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/)![0]}</body></html>`;
        const $ = cheerio.load(drawn);
        assert.strictEqual(expandThinPage($), false, 'not thin: nothing added');
        assert.ok(pageDataBlobs(cheerio.load(drawn)).length > 0);
    });

    await check('words already on the page are never repeated; code and addresses never read as words', () => {
        const prose = proseFromData([{ title: 'Hello there', body: 'Already on the page and more words here.', snippet: 'function(){return 1}', link: 'https://a.example/x' }], 'Already on the page and more words here.');
        assert.deepStrictEqual(prose, [{ kind: 'h', text: 'Hello there' }]);
    });

    console.log('\n2. srcset');

    await check('commas inside srcset addresses (GoDaddy, Wix) stay in the address', () => {
        assert.strictEqual(largestFromSrcset('https://img1.wsimg.com/a/:/rs=w:400,h:400,m 1x, https://img1.wsimg.com/a/:/rs=w:800,h:800,m 2x'), 'https://img1.wsimg.com/a/:/rs=w:800,h:800,m');
        assert.strictEqual(largestFromSrcset('a.jpg 300w, b.jpg 1200w, c.jpg 600w'), 'b.jpg');
        assert.strictEqual(largestFromSrcset('only.jpg'), 'only.jpg');
    });

    console.log('\n3. Interactive parts');

    await check('empty closed accordion panels (Radix) get the words from the page data', () => {
        const html = `<html><body><main><h2>Questions</h2><button>How long is delivery?</button><div role="region" data-state="closed" hidden></div></main>
<script>self.__next_f.push([1,${JSON.stringify(`4:["$","div",null,{"answer":"Delivery takes three to five working days anywhere in the UK mainland."}]\n`)}])</script></body></html>`;
        const $ = cheerio.load(html);
        assert.strictEqual(fillClosedPanels($), true);
        assert.ok(texts(html).some((x) => x.startsWith('Delivery takes three to five')));
    });

    await check('a button with only an aria-label (carousel arrows) is not content; an icon link still is a link', () => {
        const p = readImportPage(`<html><body><main><h1>Hi</h1><p>${words(10)}</p><button aria-label="Previous slide"></button><a href="/book" aria-label="Book a table"><svg></svg></a></main></body></html>`, 'https://x.example/');
        const btns = p.blocks.filter((b) => b.kind === 'button').map((b) => (b as { text: string }).text);
        assert.deepStrictEqual(btns, ['Book a table']);
    });

    await check('a phone-only menu drawer (fixed, md:hidden, all links) is removed; a phone-only section of words stays', () => {
        const $ = cheerio.load('<body><div class="fixed inset-0 md:hidden"><a href="/a">A</a><a href="/b">B</a></div><div class="md:hidden"><p>Call us today for a free quote on any job.</p></div></body>');
        removePhoneDrawers($);
        assert.strictEqual($('a').length, 0);
        assert.ok($('body').text().includes('Call us today'));
    });

    console.log('\n4. Addresses');

    await check('tracking parameters are dropped from addresses; others stay', () => {
        assert.strictEqual(withoutTracking(new URL('https://x.example/p?utm_source=a&utm_medium=b&id=7&fbclid=z&_hsenc=q')).toString(), 'https://x.example/p?id=7');
        const p = readImportPage('<html><body><main><h1>Hi</h1><p>Words of the page here today.</p><a class="btn" href="/book?utm_campaign=x&gclid=1">Book now</a></main></body></html>', 'https://x.example/');
        assert.strictEqual((p.blocks.find((b) => b.kind === 'button') as { href: string }).href, 'https://x.example/book');
    });

    await check('"about.html" gets the address /about, and the old /about.html forwards to it', async () => {
        const home = `<html><body><header><nav><a href="/">Home</a><a href="/about.html">About</a></nav></header><main><h1>Hi</h1><p>${words(60)}</p></main></body></html>`;
        const about = `<html><body><main><h1>About us</h1><p>${words(40, 'about')}</p></main></body></html>`;
        const site: Record<string, string> = { 'https://x.example/': home, 'https://x.example/about.html': about };
        const r = await runImport({ url: 'https://x.example/', pictures: 'skip', current: current(), maxPages: 5 }, { async fetchHtml(u) { return site[u] ? { ok: true, html: site[u], finalUrl: u } : { ok: false, message: '404' }; }, async plan() { return null; }, async savePicture() { return null; } });
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.ok(r.definition.pages.some((p) => p.slug === 'about'));
        assert.strictEqual(redirectFor(r.definition, '/about.html'), '/about');
        assert.strictEqual(redirectFor(r.definition, '/About'), '/about');
        assert.strictEqual(redirectFor(r.definition, '/about'), null, 'the page itself is served, not redirected');
    });

    console.log('\n5. WooCommerce on Elementor');

    await check('an Elementor page of a WooCommerce shop gets both tidies and its products read', () => {
        const html = `<html><head><meta name="generator" content="WooCommerce 9.0"></head><body class="elementor-kit-5 woocommerce-js home"><main>
<div class="elementor-widget-heading"><h2>Our candles</h2></div>
<ul class="products"><li class="product"><a href="https://shop.example/product/fig/" class="woocommerce-LoopProduct-link"><img src="https://shop.example/wp-content/uploads/fig-300x300.jpg"><h2 class="woocommerce-loop-product__title">Fig candle</h2><span class="price"><span class="woocommerce-Price-amount amount">£18.00</span></span></a><a href="?add-to-cart=12" class="button add_to_cart_button">Add to basket</a></li></ul>
</main></body></html>`;
        const a = adapterFor(html, cheerio.load(html));
        assert.strictEqual(a?.key, 'elementor');
        const $ = cheerio.load(html);
        const products = a!.products!($, new URL('https://shop.example/'));
        assert.ok(products.some((p) => p.name === 'Fig candle'), JSON.stringify(products));
        const p = readImportPage(html, 'https://shop.example/');
        assert.ok(!p.blocks.some((b) => 'text' in b && /Add to basket/.test((b as { text: string }).text)));
    });

    console.log('\n6. Shop feeds');

    await check('prices carry the shop\'s currency in the form Business Information reads', () => {
        assert.strictEqual(priceWithCurrency('28', 'GBP'), '£28.00');
        assert.strictEqual(priceWithCurrency(12.5, 'USD'), 'US$12.50');
        assert.strictEqual(priceWithCurrency('40', 'NZD'), '40.00 NZD');
        assert.strictEqual(priceWithCurrency('0', 'GBP'), null);
        assert.strictEqual(shopifyCurrency('<script>Shopify.currency = {"active":"EUR","rate":"1.0"};</script>'), 'EUR');
    });

    await check('Shopify /products.json and WooCommerce\'s Store API give every product: name, cheapest price, picture, page', () => {
        const sp = readShopifyFeed(JSON.stringify({ products: [{ title: 'Puff', handle: 'puff-olive', variants: [{ price: '120.00' }, { price: '140.00' }], images: [{ src: 'https://cdn.shopify.com/puff.jpg' }] }, { title: 'Tote', handle: 'tote', variants: [{ price: '55.00' }], images: [] }] }), 'https://s.example', 'GBP');
        assert.deepStrictEqual(sp, [
            { name: 'Puff', price: 'From £120.00', href: 'https://s.example/products/puff-olive', image: 'https://cdn.shopify.com/puff.jpg' },
            { name: 'Tote', price: '£55.00', href: 'https://s.example/products/tote', image: null },
        ]);
        const wc = readWooFeed(JSON.stringify([{ name: 'Fig candle', permalink: 'https://w.example/product/fig/', prices: { price: '1800', currency_code: 'GBP', currency_minor_unit: 2 }, images: [{ src: 'https://w.example/fig.jpg' }] }]));
        assert.deepStrictEqual(wc, [{ name: 'Fig candle', price: '£18.00', href: 'https://w.example/product/fig/', image: 'https://w.example/fig.jpg' }]);
        assert.strictEqual(shopFeedUrl('shopify', 'https://s.example'), 'https://s.example/products.json?limit=250');
        assert.strictEqual(shopFeedUrl('wix', 'https://s.example'), null);
    });

    await check('the import adds the feed\'s products after the pages\' own, each once', async () => {
        const home = `<html><head><script>Shopify.currency = {"active":"GBP"};</script></head><body class="template-index"><div id="shopify-section-header" class="shopify-section"></div><main><h1>Bags</h1><p>${words(260)}</p></main><script src="https://cdn.shopify.com/s/files/theme.js"></script><script>Shopify.theme = {"name":"Dawn"};</script></body></html>`;
        const feed = JSON.stringify({ products: [{ title: 'Puff', handle: 'puff', variants: [{ price: '120.00' }], images: [] }, { title: 'Tote', handle: 'tote', variants: [{ price: '55.00' }], images: [] }] });
        const asked: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(u) { return u === 'https://s.example/' ? { ok: true, html: home, finalUrl: u } : { ok: false, message: '404' }; },
            async fetchJson(u) { asked.push(u); return { ok: true, html: feed, finalUrl: u }; },
            async plan() { return null; }, async savePicture() { return null; },
        };
        const r = await runImport({ url: 'https://s.example/', pictures: 'skip', current: current(), maxPages: 5 }, deps);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'shopify');
        assert.ok(asked.includes('https://s.example/products.json?limit=250'));
        assert.deepStrictEqual(r.report.products?.map((p) => [p.name, p.price]), [['Puff', '£120.00'], ['Tote', '£55.00']]);
    });

    console.log('\n7. One-page sites');

    await check('a one-page site whose menu jumps to sections becomes a one-page hosted site with that menu', async () => {
        const html = `<html><body><header><nav><a href="#about">About</a><a href="#work">Our work</a><a href="/#contact">Contact</a></nav></header><main>
<section id="intro"><h1>Hannah Lee Illustration</h1><p>${words(30, 'intro')}</p></section>
<section id="about"><h2>About me</h2><p>${words(30, 'about')}</p></section>
<section id="work"><h2>Selected work</h2><p>${words(30, 'work')}</p></section>
<section id="contact"><h2>Say hello</h2><p>${words(20, 'contact')}</p></section></main></body></html>`;
        assert.deepStrictEqual(readImportPage(html, 'https://h.example/').anchorNav, [{ text: 'About', id: 'about' }, { text: 'Our work', id: 'work' }, { text: 'Contact', id: 'contact' }]);
        const r = await runImport({ url: 'https://h.example/', pictures: 'skip', current: current(), maxPages: 5 }, { async fetchHtml(u) { return u === 'https://h.example/' ? { ok: true, html, finalUrl: u } : { ok: false, message: '404' }; }, async plan() { return null; }, async savePicture() { return null; } });
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.strictEqual(r.definition.structure, 'one_page');
        const labels = r.definition.pages[0].sections.map((s) => s.look?.menuLabel).filter(Boolean);
        assert.deepStrictEqual(labels, ['About', 'Our work', 'Contact']);
        assert.deepStrictEqual(normaliseSiteDefinition(r.definition).definition.structure, 'one_page');
    });

    await check('a site with real pages keeps its pages, even when its menu also has jump links', async () => {
        const home = `<html><body><header><nav><a href="#about">About</a><a href="#work">Work</a><a href="/prices">Prices</a></nav></header><main>
<section id="about"><h2>About me</h2><p>${words(80, 'a')}</p></section><section id="work"><h2>Work</h2><p>${words(80, 'w')}</p></section></main></body></html>`;
        const prices = `<html><body><main><h1>Prices</h1><p>${words(60, 'p')}</p></main></body></html>`;
        const site: Record<string, string> = { 'https://k.example/': home, 'https://k.example/prices': prices };
        const r = await runImport({ url: 'https://k.example/', pictures: 'skip', current: current(), maxPages: 5 }, { async fetchHtml(u) { return site[u] ? { ok: true, html: site[u], finalUrl: u } : { ok: false, message: '404' }; }, async plan() { return null; }, async savePicture() { return null; } });
        assert.ok(r.ok && r.definition.structure === 'pages' && r.definition.pages.length >= 2);
    });

    console.log(`\n${passed}/${total} passed`);
}
void main();
