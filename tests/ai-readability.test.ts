// tests/ai-readability.test.ts
// The build-time copy that lets crawlers and AI assistants read prices and assistant pages without
// running JavaScript (scripts/seo/ai-readability.mjs, Jobs 5–8 of scripts/build-seo-html.mjs).
//
// Every failure this guards against is SILENT: the deploy succeeds, the page looks right to anyone
// with a browser, and only a crawler sees a blank price or a page titled "Digital Assistant". So the
// builders are driven with fixtures here, against the REAL page templates, so a template change that
// moves an anchor fails CI instead of quietly failing the build — or worse, not failing it.
//
// Run:  npx tsx tests/ai-readability.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    bakePlanPriceSlots, pricingCardTexts, applyTextById, pricingJsonLd, formatGbp,
    ASSISTANT_PAGE_SLUGS, slugForRole, isLiveRole, buildAssistantPage, assistantPagesJs,
    libraryStaticCards, sitemapEntries, llmsGeneratedSections,
} from '../scripts/seo/ai-readability.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const PLANS = [
    { tierKey: 'saver', name: 'The Workflow Saver', tierDescription: 'Tier 1 · Best for solo business owners', description: 'One assistant.', monthlyPriceGbp: '29.00', assistantLimit: 1, monthlyTaskLimit: 600, isContactSales: false },
    { tierKey: 'buster', name: 'The Busywork Buster', tierDescription: 'Best for growing businesses', description: 'Every assistant.', monthlyPriceGbp: '69.00', assistantLimit: null, monthlyTaskLimit: 2750, isContactSales: false },
];
const ENTERPRISE = { tierKey: 'enterprise', name: 'Bespoke Assistant', description: 'Built for you.', isContactSales: true, monthlyPriceGbp: '0' };
const SOCIAL = { roleKey: 'social_media_manager', name: 'Social Media Assistant', tagline: 'Posts in your voice', category: 'Marketing & Sales', comingSoon: false, beta: false, worksWith: ['standalone', 'blog_writer'] };
const BLOG = { roleKey: 'blog_writer', name: 'Blog Writing Assistant', tagline: 'Articles', comingSoon: false, beta: false, worksWith: [] };
const SOON = { roleKey: 'inbox_manager', name: 'Inbox Assistant', tagline: 'Email triage', comingSoon: true, beta: false };
const SHOWCASE = {
    headline: 'Your social media, planned & written </script><b>',
    overview: ['It drafts posts.'],
    highlights: ['You approve first'],
    steps: [{ title: 'Connect', body: 'Link accounts.' }],
    features: [{ title: 'Drafts on schedule', body: 'Keeps the queue stocked.' }],
    faqs: [{ q: 'Does it post without me?', a: 'Not unless you allow it.' }],
};

console.log('Plan prices');

check('formatGbp matches pricing.html fmtGbp: whole pounds stay whole, pence show two digits', () => {
    assert.strictEqual(formatGbp('69.00'), '£69');
    assert.strictEqual(formatGbp(55.2), '£55.20');
    assert.strictEqual(formatGbp(1200), '£1,200');
});

check('the home page price sentences are filled and unhidden', () => {
    const { html, filled, missing } = bakePlanPriceSlots(read('index.html'), PLANS);
    assert.ok(filled >= 2, `filled ${filled} slots`);
    assert.deepStrictEqual(missing, []);
    assert.match(html, /<span data-plan-price="saver">£29<\/span>/);
    assert.doesNotMatch(html, /data-plan-prices-ready hidden/, 'a filled sentence must not stay hidden');
});

check('a missing price keeps EVERY sentence hidden rather than reading "Plans start at /month"', () => {
    const { html, missing } = bakePlanPriceSlots(read('index.html'), PLANS.slice(1));
    assert.deepStrictEqual(missing, ['saver']);
    assert.match(html, /data-plan-prices-ready hidden/);
});

check('baking twice gives the same page (a deploy retry must not change the output)', () => {
    const once = bakePlanPriceSlots(read('index.html'), PLANS).html;
    assert.strictEqual(bakePlanPriceSlots(once, PLANS).html, once);
});

check('the pricing cards get both prices, names and limits from master data', () => {
    const texts = pricingCardTexts(PLANS, ENTERPRISE);
    assert.strictEqual(texts['card-price-t1'], '£29');
    assert.strictEqual(texts['card-price-t2'], '£69');
    assert.strictEqual(texts['card-tier-t1'], 'Best for solo business owners', '"Tier N ·" prefix stripped like stripTierPrefix()');
    assert.strictEqual(texts['stat-asst-t2'], 'All', 'a null assistant limit reads as every assistant');
    assert.strictEqual(texts['stat-task-t2'], '2.75k');
    assert.strictEqual(texts['card-name-t4'], 'Bespoke Assistant');
    assert.ok(!('card-price-t4' in texts), 'a contact-sales plan has no price');
});

check('pricing.html still has text-only #card-price-t1 / #card-price-t2 slots to fill', () => {
    const { applied } = applyTextById(read('pricing.html'), pricingCardTexts(PLANS, ENTERPRISE));
    for (const id of ['card-price-t1', 'card-price-t2', 'tbl-price-t1', 'anchor-price', 'final-cta-price']) {
        assert.ok(applied.includes(id), `#${id} not filled`);
    }
});

check('pricing.html writes no price of its own (owner rule 2026-10-19) — the build is the only writer', () => {
    const src = read('pricing.html');
    for (const id of ['card-price-t1', 'card-price-t2']) {
        assert.match(src, new RegExp(`id="${id}"[^>]*>&nbsp;<`), `#${id} must stay an empty slot in source`);
    }
});

check('Offer JSON-LD lists each purchasable plan in GBP and parses', () => {
    const block = pricingJsonLd([...PLANS, ENTERPRISE]);
    const json = JSON.parse(block.replace(/^[\s\S]*?<script[^>]*>/, '').replace(/<\/script>\s*$/, ''));
    assert.strictEqual(json['@id'], 'https://bemoreswan.com/#software');
    assert.deepStrictEqual(json.offers.map((o: { price: string }) => o.price), ['29.00', '69.00']);
    assert.ok(json.offers.every((o: { priceCurrency: string }) => o.priceCurrency === 'GBP'));
});

console.log('Assistant pages');

check('every pinned slug starts with "ai-" (netlify.toml noindexes /assistant-*)', () => {
    for (const [role, slug] of Object.entries(ASSISTANT_PAGE_SLUGS)) {
        assert.match(slug, /^ai-[a-z0-9-]+$/, `${role} → ${slug}`);
    }
    assert.match(read('netlify.toml'), /for = "\/assistant-\*"/, 'the rule this guards against has moved — re-check the slugs');
});

check('no pinned slug collides with a page already in the repo', () => {
    for (const slug of Object.values(ASSISTANT_PAGE_SLUGS)) {
        assert.ok(!readdirSync(root).includes(`${slug}.html`), `${slug}.html exists in source — the build would overwrite it`);
    }
});

check('an unpinned live role still gets an "ai-" page from its name', () => {
    assert.deepStrictEqual(slugForRole('new_role', 'Proposal Writer'), { slug: 'ai-proposal-writer', pinned: false });
    assert.strictEqual(slugForRole('blog_writer', 'Renamed In Admin').slug, 'ai-blog-writing-assistant', 'a rename must not move the URL');
});

check('only hireable roles get pages: coming-soon and early-access do not', () => {
    assert.ok(isLiveRole(SOCIAL));
    assert.ok(!isLiveRole(SOON));
    assert.ok(!isLiveRole({ ...SOCIAL, beta: true }));
});

const pages = { social_media_manager: { slug: 'ai-social-media-assistant', name: SOCIAL.name }, blog_writer: { slug: 'ai-blog-writing-assistant', name: BLOG.name } };
const built = buildAssistantPage(read('assistant.html'), {
    roleKey: 'social_media_manager', slug: 'ai-social-media-assistant', c: SOCIAL, sc: SHOWCASE, pages, ogImage: 'https://bemoreswan.com/x.jpg',
});

check('assistant.html still has every anchor the page builder edits', () => {
    assert.deepStrictEqual(built.errors, []);
});

check('the generated page has its own title, canonical, role meta and no noindex', () => {
    const h = built.html;
    assert.match(h, /<title>Social Media Assistant for small businesses \| Be More Swan<\/title>/);
    assert.match(h, /<link rel="canonical" href="https:\/\/bemoreswan.com\/ai-social-media-assistant">/);
    assert.match(h, /<meta name="bms-role" content="social_media_manager">/);
    assert.doesNotMatch(h, /<meta name="robots" content="noindex/);
    assert.match(h, /<div id="sc-loading" class="hidden /);
});

check('the shell (assistant.html) stays noindex — it is the same document for every role', () => {
    assert.match(read('assistant.html'), /<meta name="robots" content="noindex, follow">/);
});

check('the crawler copy carries the showcase: one h1, overview, steps, features, FAQs, Works-with link', () => {
    const s = built.html.slice(built.html.indexOf('<div id="sc-static">'));
    // Outside <script>: render()'s template string holds the live page's own <h1>.
    const markup = built.html.replace(/<script\b[\s\S]*?<\/script>/g, '');
    assert.strictEqual((markup.match(/<h1\b/g) || []).length, 1, 'exactly one <h1> in the served markup');
    for (const t of ['It drafts posts.', 'Link accounts.', 'Keeps the queue stocked.', 'Does it post without me?']) assert.ok(s.includes(t), t);
    assert.match(s, /<a href="\/ai-blog-writing-assistant"/);
});

check('admin copy is escaped in HTML and cannot close the JSON-LD script', () => {
    assert.ok(!built.html.includes('</script><b>'), 'raw headline leaked');
    const blocks = [...built.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.strictEqual(blocks.length, 1);
    const graph = JSON.parse(blocks[0][1])['@graph'];
    assert.deepStrictEqual(graph.map((n: { '@type': string }) => n['@type']), ['WebPage', 'Service', 'FAQPage']);
    assert.strictEqual(graph[1].description, SHOWCASE.headline, 'the escape must round-trip to the same text');
});

check('the page script reads the baked role, forwards ?role= links and drops the crawler copy', () => {
    const src = read('assistant.html');
    assert.match(src, /meta\[name="bms-role"\]/);
    assert.match(src, /location\.replace\(/);
    assert.match(src, /getElementById\('sc-static'\)\?\.remove\(\)/);
    assert.match(src, /<script src="\/assistant-pages\.js"><\/script>/, 'the map must load before the inline script');
});

check('the committed assistant-pages.js is empty, so an unbuilt checkout keeps ?role= links', () => {
    assert.match(read('assistant-pages.js'), /window\.BmsAssistantPages = \{\};/);
    assert.match(assistantPagesJs(pages), /"social_media_manager": "ai-social-media-assistant"/);
});

check('the library cards link to the pages and skip coming-soon roles; the library loads the map', () => {
    const cards = libraryStaticCards([SOCIAL, BLOG, SOON], pages);
    assert.match(cards, /href="\/ai-social-media-assistant"/);
    assert.ok(!cards.includes('Inbox Assistant'));
    assert.match(read('assistants.html'), /<!-- Loading skeleton -->/, 'Job 6 anchors the library cards here');
    assert.match(read('assistants.html'), /BmsAssistantPages/);
});

check('sitemap entries use the extensionless URL (the form every shipped link uses)', () => {
    assert.strictEqual(sitemapEntries({ a: { slug: 'ai-x', name: 'X' } }), '  <url>\n    <loc>https://bemoreswan.com/ai-x</loc>\n  </url>');
    assert.match(read('sitemap.xml'), /<\/urlset>/);
});

console.log('llms.txt');

check('llms.txt has the region the build fills', () => {
    const src = read('llms.txt');
    assert.ok(src.includes('<!-- BUILD:LLMS-GENERATED -->') && src.includes('<!-- /BUILD:LLMS-GENERATED -->'));
});

check('the generated sections quote live prices, link live pages and help articles, and label coming-soon roles', () => {
    const out = llmsGeneratedSections({
        assistants: [SOCIAL, SOON], showcases: { social_media_manager: SHOWCASE }, pages,
        plans: PLANS, enterprisePlan: ENTERPRISE, articles: [{ title: "Why Can't This Lead Be Emailed?" }],
    });
    assert.match(out, /\[Social Media Assistant\]\(https:\/\/bemoreswan.com\/ai-social-media-assistant\)/);
    assert.match(out, /The Workflow Saver: £29 a month/);
    assert.match(out, /every assistant and 2,750 tasks a month/);
    assert.match(out, /Bespoke Assistant: priced on request/);
    assert.match(out, /## Coming soon[\s\S]*Inbox Assistant/);
    // help.html's slugify() turns the apostrophe into a hyphen; the link must match it to open.
    assert.match(out, /\/help#why-can-t-this-lead-be-emailed\)/);
});

console.log('IndexNow');

check('exactly one key file sits at the root, and its content is its own name', () => {
    const keys = readdirSync(root).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
    assert.strictEqual(keys.length, 1, `found ${keys.length} key files`);
    assert.strictEqual(read(keys[0]).trim(), keys[0].slice(0, -4));
});

check('the ping runs last in the build command and is production-gated', () => {
    assert.match(read('netlify.toml'), /command = "[^"]*build:seo-html && node scripts\/indexnow-ping\.mjs"/);
    const ping = read('scripts/indexnow-ping.mjs');
    assert.match(ping, /process\.env\.CONTEXT !== 'production'/);
    assert.match(ping, /process\.exit\(0\)/, 'a ping must never fail the build');
});

console.log('Rebuild on plan change');

check('every price change path rebuilds the site (applyPlanPrice is where they converge)', () => {
    assert.match(read('src/utils/plan-pricing.ts'), /await triggerSiteRebuild\(/);
    assert.match(read('src/utils/trigger-site-rebuild.ts'), /process\.env\.SITE_REBUILD_HOOK/);
});

check('plan create / edit / delete in Admin rebuild too, and a price edit rebuilds once, not twice', () => {
    const src = read('netlify/functions/master-data-api.ts');
    assert.strictEqual((src.match(/await triggerSiteRebuild\(/g) || []).length, 3);
    assert.match(src, /if \(!priceChanged && publishedFields\.some/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
