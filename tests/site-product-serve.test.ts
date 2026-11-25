// tests/site-product-serve.test.ts
// Online shop Phase 1 (FR#35): the REAL serving branch for a product's own page, /shop/<id>-<name>
// (netlify/functions/site-serve.ts productPageResponse), driven with stand-ins for its two reads.
// Added after the #868 review: until then the 404 / 301 / HEAD paths were only checked by reading the source,
// and a staging site can't be opened in a browser (*.bemoreswan.site forwards to production only).
//
// Run:  npx tsx tests/site-product-serve.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { productPageResponse } from '../netlify/functions/site-serve';
import { normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import type { SiteProduct } from '../src/utils/site-shop';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const site = (productIds: number[]): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee' },
    pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Fresh coffee' } }] },
        { title: 'Shop', slug: 'shop', sections: [{ type: 'products', props: { heading: 'Our coffee', productIds } }] },
    ],
}).definition;
const BLEND: SiteProduct = { id: 11, name: 'House Blend', description: 'Our everyday coffee.', price: '£12.50', buyPence: 1250, imageAssetId: null };
const ctx = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null };

/** Serve `path` with these Business Information products; counts the reads so a skipped read is visible. */
async function serve(path: string, opts: { products?: Record<number, SiteProduct>; offered?: number[]; query?: string; method?: string; selling?: boolean } = {}) {
    const reads = { products: 0, canSell: 0 };
    const res = await productPageResponse({
        path, query: opts.query ?? '', method: opts.method ?? 'GET', definition: site(opts.offered ?? [11]), ctx,
        loadProducts: async () => { reads.products++; return opts.products ?? { 11: BLEND }; },
        canSell: async () => { reads.canSell++; return opts.selling ?? true; },
    });
    return { res, reads };
}

async function main() {
    console.log('\nServing /shop/<id>-<name>');

    await check('an offered, active product: 200 with its page, cached a minute', async () => {
        const { res, reads } = await serve('/shop/11-house-blend');
        assert.ok(res && res.statusCode === 200);
        assert.strictEqual(res!.headers['Content-Type'], 'text/html; charset=utf-8');
        assert.strictEqual(res!.headers['Cache-Control'], 'public, max-age=60');
        assert.ok(res!.body.includes('<h1>House Blend</h1>') && res!.body.includes('name="_pid" value="11"'));
        assert.deepStrictEqual(reads, { products: 1, canSell: 1 });
    });

    await check('not selling yet (no Stripe / no Delivery & returns): the page shows, with no Buy form', async () => {
        const { res } = await serve('/shop/11-house-blend', { selling: false });
        assert.ok(res && res.statusCode === 200 && res.body.includes('£12.50') && !res.body.includes('name="_pid"'));
    });

    await check('a trailing slash on the current address is served, its canonical naming the address without it', async () => {
        const { res } = await serve('/shop/11-house-blend/');
        assert.ok(res && res.statusCode === 200);
        assert.ok(res!.body.includes('<link rel="canonical" href="https://willowbrook.bemoreswan.site/shop/11-house-blend">'));
    });

    await check('HEAD: the same answer with no body', async () => {
        const { res } = await serve('/shop/11-house-blend', { method: 'HEAD' });
        assert.ok(res && res.statusCode === 200 && res.body === '');
    });

    await check('offered by a section but archived or removed in Business Information: 404 (the site\'s own not-found page)', async () => {
        const { res, reads } = await serve('/shop/11-house-blend', { products: {} });
        assert.ok(res && res.statusCode === 404);
        assert.ok(res!.body.includes('Page not found'));
        assert.strictEqual(reads.canSell, 0, 'no Stripe read for a page that isn\'t there');
    });

    await check('an old name, another case or no name at all: 301 to the current address, keeping the query', async () => {
        for (const old of ['/shop/11-old-name', '/shop/11-House-Blend', '/shop/11-old-name/', '/shop/11']) {
            const { res, reads } = await serve(old, { query: 'utm_source=instagram&utm_campaign=autumn' });
            assert.ok(res && res.statusCode === 301, old);
            assert.strictEqual(res!.headers.Location, '/shop/11-house-blend?utm_source=instagram&utm_campaign=autumn', old);
            assert.strictEqual(res!.body, '');
            assert.strictEqual(reads.canSell, 0, 'a redirect never reads Stripe');
        }
        const plain = await serve('/shop/11-old-name');
        assert.strictEqual(plain.res!.headers.Location, '/shop/11-house-blend', 'no query → no "?"');
    });

    await check('not a product page of THIS site: null (the request carries on), and nothing is read', async () => {
        for (const [path, offered] of [['/shop/12-other', [11]], ['/shop', [11]], ['/about', [11]], ['/shop/11-house-blend', [12]]] as const) {
            const { res, reads } = await serve(path, { offered: [...offered] });
            assert.strictEqual(res, null, `${path} with ${offered}`);
            assert.deepStrictEqual(reads, { products: 0, canSell: 0 }, `${path}: no database read`);
        }
    });

    await check('the handler serves product pages through this function, before old-address redirects', async () => {
        const src = readFileSync(join(__dirname, '..', 'netlify/functions/site-serve.ts'), 'utf8');
        const call = src.indexOf('const productPage = await productPageResponse({');
        assert.ok(call > 0 && src.includes('if (productPage) return productPage;'));
        assert.ok(src.includes('loadProducts: () => loadSiteProducts(db, site.organisationId, definition)') && src.includes('canSell: () => canSell(db, site.organisationId)'));
        assert.ok(call < src.indexOf('const moved = redirectFor(definition, path);'));
    });

    console.log(`\n${passed}/${total} passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
