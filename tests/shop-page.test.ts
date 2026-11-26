// tests/shop-page.test.ts
// Online shop Phase 1, last slice (FR#35, docs/online-shop-review-plan.md §6): a shop page for a business with no
// Be More Swan website. An ordinary hosted site owned by the Shopkeeper, drawn by the same renderer — its one page
// is written here (src/utils/shop-page.ts); product pages, basket, checkout and Delivery & returns come with it.
//
// Run:  npx tsx tests/shop-page.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shopPageDefinition, shopPageSnapshotLines, SHOP_PAGE_MAX_PRODUCTS, type ShopPageState } from '../src/utils/shop-page';
import { placeholdersIn } from '../src/utils/site-draft';
import { publishBlocker, type SiteRow } from '../src/utils/site-store';
import { shopTermsHtml, EMPTY_SHOP_SETTINGS } from '../src/utils/shop-settings';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const products = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Thing ${i + 1}` }));

(async () => {
    console.log('\nshop-page');

    await check('one page: the name, every product in sections of 12, how to reach them; a Store; nothing left to fill in', () => {
        const def = shopPageDefinition({ name: 'Kudzu Candles', description: 'Hand-poured soy candles from Leeds.', contactEmail: 'hello@kudzu.example', brandKit: { colors: { primary: '#112233' } }, products: products(30) });
        assert.strictEqual(def.pages.length, 1);
        const [page] = def.pages;
        assert.strictEqual(page.slug, '');
        const types = page.sections.map((s) => s.type);
        assert.deepStrictEqual(types, ['hero', 'products', 'products', 'products', 'text']);
        const prods = page.sections.filter((s) => s.type === 'products') as Array<{ props: { productIds: number[]; heading: string | null } }>;
        assert.deepStrictEqual(prods.map((s) => s.props.productIds.length), [12, 12, 6]);
        assert.strictEqual(prods[0].props.heading, 'Shop');
        assert.deepStrictEqual(prods.flatMap((s) => s.props.productIds), products(30).map((p) => p.id));
        assert.ok(JSON.stringify(page.sections[0]).includes('Kudzu Candles') && JSON.stringify(page.sections[4]).includes('hello@kudzu.example'));
        assert.strictEqual(def.settings.businessType, 'Store');
        assert.deepStrictEqual(placeholdersIn(def), []);
        // Publishable once it has an address (the same check a website's Publish runs).
        assert.strictEqual(publishBlocker({ status: 'draft', slug: 'kudzu-candles' } as SiteRow, def), null);
    });

    await check(`at most ${SHOP_PAGE_MAX_PRODUCTS} products; no email → no contact line; no description → plain words, never a [placeholder]`, () => {
        const def = shopPageDefinition({ name: 'Tea & Co', description: null, contactEmail: null, brandKit: null, products: products(60) });
        const ids = def.pages[0].sections.filter((s) => s.type === 'products').flatMap((s) => (s.props as { productIds: number[] }).productIds);
        assert.strictEqual(ids.length, SHOP_PAGE_MAX_PRODUCTS);
        assert.ok(!def.pages[0].sections.some((s) => s.type === 'text'));
        assert.deepStrictEqual(placeholdersIn(def), []);
    });

    await check('chat snapshot: each state, live lists the product links', () => {
        const base: ShopPageState = { state: 'none', url: null, websiteUrl: null, slug: null, suggestedSlug: 'kudzu', domain: 'bemoreswan.site', publishedAt: null, productLinks: [], notYetOn: 0 };
        assert.ok(shopPageSnapshotLines(base).join('\n').includes('"Publish shop page"'));
        assert.ok(shopPageSnapshotLines({ ...base, state: 'website', websiteUrl: 'https://kudzu.bemoreswan.site' }).join('\n').includes('not needed'));
        const live = shopPageSnapshotLines({ ...base, state: 'live', url: 'https://kudzu.bemoreswan.site', productLinks: [{ id: 3, name: 'Fig candle', url: 'https://kudzu.bemoreswan.site/shop/3-fig-candle' }] }).join('\n');
        assert.ok(live.includes('live at https://kudzu.bemoreswan.site') && live.includes('- Fig candle: https://kudzu.bemoreswan.site/shop/3-fig-candle') && live.includes('"Update shop page"'));
        assert.deepStrictEqual(shopPageSnapshotLines(null), []);
        // review #884: a product for sale but not on the published page has no link yet, and the chat is told.
        const behind = shopPageSnapshotLines({ ...base, state: 'live', url: 'https://kudzu.bemoreswan.site', notYetOn: 2 }).join('\n');
        assert.ok(behind.includes('2 products for sale are NOT on the page yet and have no link until they press "Update shop page"'));
    });

    await check('Delivery & returns page carries privacy wording for the buyer', () => {
        assert.ok(shopTermsHtml({ ...EMPTY_SHOP_SETTINGS, traderName: 'Kudzu', contactEmail: 'a@b.c' }).includes('<h2>Your details</h2>'));
    });

    await check('publishing: owner/admin, shop ready, safety check, a click only; refused when a website already sells; no products refused', () => {
        const fn = read('netlify/functions/shop.ts');
        assert.ok(fn.includes("if (action === 'shop_page_publish') {") && fn.includes("if (!canEdit) return json(403, { error: 'Only the workspace owner or an admin can publish the shop page.' });"));
        assert.ok(fn.includes('const left = shopStepsLeft(') && fn.includes('enforcePromptModeration({ text: siteVisibleText(def)'));
        assert.ok(fn.includes('await purgeSitePages(r.oldSlug);') && fn.includes('await refreshDirectoryAfterPublish(db, orgId);'));
        assert.ok(fn.includes("if (action === 'shop_page_offline') {") && fn.includes('await refreshDirectoryAfterAddressChange(db, orgId);'));
        const mod = read('src/utils/shop-page.ts');
        assert.ok(mod.includes('Your website already sells your products, so a separate shop page isn') && mod.includes('Add at least one product with a fixed price'));
        assert.ok(mod.includes('const r = await publishSite(db, site, o.userId, 1);') && mod.includes("eq(orgProducts.kind, 'product')"));
        // Never a chat card: the chat points to the buttons.
        assert.ok(!read('src/components/disruptive-ui-registry.js').includes("register('shop_page'"));
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('SHOP PAGE. The SHOP PAGE line above says where it stands.') && orch.includes("you can't press them, so point to them") && !orch.includes('a shop page of its own is coming'));
        assert.ok(orch.includes('buildShopSnapshot(db, orgId, session.aiAssistantId)'));
    });

    await check('Shop tab card, Mystery Shopper hand-off limited to Website Assistants, public copy no longer says a website is needed', () => {
        const tab = read('src/components/assistant-shop.js');
        assert.ok(tab.includes('${shopPageCard(state.data)}') && tab.includes("action: 'shop_page_publish', slug:") && tab.includes("action: 'shop_page_offline'") && tab.includes('data-page-copy'));
        assert.ok(read('src/utils/site-audit-recheck.ts').includes("sql`(${aiAssistants.configuration} ->> 'type') = ${WEBSITE_ASSISTANT_ROLE_KEY}`"));
        const show = JSON.parse(read('db/assistant-showcases.json')).shopkeeper;
        assert.ok(show.faqs[1].a.startsWith('No.') && show.faqs[1].a.includes('shop page of your own'));
        assert.ok(!JSON.stringify(show).includes("you'll want one of those to sell"));
        assert.ok(read('db/z-assistant-showcases.sql').includes('publish a shop page of your own from the Shop tab'));
        // Showcase + Shop tab match what's built: a basket, posted + tracking email, CSV (no "Buy buttons show" / "dealt with").
        const showText = JSON.stringify(show);
        assert.ok(showText.includes('Mark one as posted, with a tracking number') && showText.includes('if your Gmail or Outlook is connected, the buyer gets an email from it') && !showText.includes('from your own Gmail or Outlook') && showText.includes('spreadsheet (CSV)') && showText.includes('add your products to a basket'));
        for (const f of ['db/assistant-showcases.json', 'db/z-assistant-showcases.sql', 'src/components/assistant-shop.js']) {
            assert.ok(!read(f).includes('Buy buttons show on your products') && !read(f).includes('Mark each one as dealt with'), f);
        }
    });

    await check('review #884: links only for products on the PUBLISHED page; a website wins over a shop page; archived can\'t publish', () => {
        const mod = read('src/utils/shop-page.ts');
        assert.ok(mod.includes('const products = now.filter((p) => onPage.has(p.id));') && mod.includes('publishedProductIds(db, own!.id, own!.publishedVersion)'));
        assert.ok(mod.includes("export const websiteSiteFirst = sql`CASE WHEN (${aiAssistants.configuration} ->> 'type') = 'website_assistant' THEN 0 ELSE 1 END`;"));
        assert.ok(read('src/utils/site-directory-store.ts').includes('.orderBy(websiteSiteFirst).limit(1);'));
        assert.ok(read('src/utils/site-booking-page.ts').includes('.orderBy(websiteSiteFirst, desc(sites.publishedAt), desc(sites.id))'));
        assert.ok(read('src/utils/site-shop.ts').includes('.where(eq(sites.organisationId, orgId)).orderBy(websiteSiteFirst).limit(1);'));
        assert.ok(read('netlify/functions/shop.ts').includes("if (assistant.archivedAt || assistant.lifecycleStatus === 'archived') return json(409,"));
        assert.ok(read('src/components/assistant-shop.js').includes('data-page-not-yet'));
    });

    console.log(`\n${passed}/${total} passed`);
})();
