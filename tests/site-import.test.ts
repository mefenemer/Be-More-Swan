// tests/site-import.test.ts
// The Website Assistant's "Import my current site" (site-import.ts, site-extract.ts readImportPage,
// site-import-store.ts, sites.ts import / import_accept / import_discard). Saved pages only — no
// network: tests/fixtures/site-import/ (and the Mystery Shopper's tests/fixtures/site-pages/).
//
//   1. Reading a page: their words and pictures in order, never the builder's menus, banners or HTML.
//   2. The plan is block numbers; the words on the draft are theirs by construction; prices stay out.
//   3. A site we can't read (JavaScript-only) is said plainly and costs nothing.
//   4. GUI and chat reach the same server action; nothing replaces the draft until the owner says so.
//
// Run:  npx tsx tests/site-import.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fullSizeImageUrl, readImportPage, statesPrice } from '../src/utils/site-extract';
import {
    assembleImport, buildImportPrompt, cleanImportUrl, draftWordsAllFromSource, numberBlocks, pickImportPages, picturesInPlan,
    readImportPlan, runImport, thinMessage, type ImportDeps, type ReadPage,
} from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { parseRobots, robotsAllowsPath } from '../src/lib/robots';
import { normaliseSiteDefinition } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const fixture = (f: string) => read(`tests/fixtures/site-import/${f}.html`);
const SITE = 'https://willow.example';
const PAGES: Record<string, string> = {
    [`${SITE}/`]: fixture('sqsp-home'),
    [`${SITE}/services`]: fixture('sqsp-services'),
    [`${SITE}/contact`]: fixture('sqsp-contact'),
};
const current = () => starterSite({ name: 'Willow & Thread', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
const readPage = (url: string, menuLabel: string | null): ReadPage => ({ url, menuLabel, page: readImportPage(PAGES[url], url) });

/** Fake outside world: saved pages, a canned plan, a picture library that records what it was asked. */
function deps(opts: { plan?: unknown; pages?: Record<string, string> } = {}): ImportDeps & { calls: { plan: number; pictures: string[] } } {
    const pages = opts.pages ?? PAGES;
    const calls = { plan: 0, pictures: [] as string[] };
    return {
        calls,
        async fetchHtml(url) {
            const html = pages[url] ?? pages[url.replace(/\/$/, '')];
            return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' };
        },
        async plan() { calls.plan++; return opts.plan ?? null; },
        async savePicture(src) { calls.pictures.push(src); return 900 + calls.pictures.length; },
    };
}

async function main() {
    console.log('\nReading a page');

    await check('their words come out in order as blocks: headings, paragraphs, list items, a quote, a button, a picture', () => {
        const p = readImportPage(fixture('sqsp-home'), `${SITE}/`);
        const kinds = p.blocks.map((b) => b.kind);
        assert.deepStrictEqual(kinds.slice(0, 6), ['heading', 'text', 'button', 'image', 'heading', 'item']);
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('saved my favourite coat')));
        assert.strictEqual(p.builder, 'squarespace');
    });

    await check('menus, header, footer, cookie banner and "Powered by" lines are not content', () => {
        const p = readImportPage(fixture('sqsp-home'), `${SITE}/`);
        const text = p.blocks.map((b) => ('text' in b ? b.text : '')).join(' | ');
        for (const noise of ['We use cookies', 'Accept', 'Powered by', '© 2026', 'Instagram', 'Privacy']) assert.ok(!text.includes(noise), noise);
    });

    await check('a sentence the builder draws twice (desktop and phone layouts) is read once', () => {
        const p = readImportPage(fixture('sqsp-home'), `${SITE}/`);
        assert.strictEqual(p.blocks.filter((b) => b.kind === 'text' && b.text.startsWith('We take up hems')).length, 1);
        const w = readImportPage(fixture('wix-home'), 'https://www.crumb.example/');
        assert.strictEqual(w.blocks.filter((b) => b.kind === 'text' && b.text.startsWith('Sourdough')).length, 1);
    });

    await check('Wix\'s "top of page" / "bottom of page" and other builder lines are dropped', () => {
        const w = readImportPage(fixture('wix-home'), 'https://www.crumb.example/');
        assert.ok(!w.blocks.some((b) => 'text' in b && /of page/.test(b.text)));
        assert.strictEqual(w.builder, 'wix');
        const s = readImportPage(fixture('sqsp-services'), `${SITE}/services`);
        assert.ok(!s.blocks.some((b) => 'text' in b && /top of page|Copyright/.test(b.text)));
    });

    await check('a page\'s own header inside an article keeps its H1 (WordPress); the site header goes', () => {
        const s = readImportPage(fixture('sqsp-services'), `${SITE}/services`);
        assert.deepStrictEqual(s.blocks[0], { kind: 'heading', level: 1, text: 'Our services' });
    });

    await check('contact details: mailto, tel (one number once), JSON-LD phone, address and town', () => {
        const p = readImportPage(fixture('sqsp-home'), `${SITE}/`);
        assert.deepStrictEqual(p.contact.emails, ['hello@willowandthread.example']);
        assert.deepStrictEqual(p.contact.phones, ['01423 000000']);
        assert.strictEqual(p.contact.address, '4 Station Parade, Harrogate, HG1 1AA');
        assert.strictEqual(p.contact.locality, 'Harrogate');
        assert.strictEqual(p.siteName, 'Willow & Thread');
    });

    await check('pictures: the largest of a srcset, icons skipped, a file name is not a description, builders\' resized copies made full size', () => {
        const p = readImportPage(fixture('sqsp-home'), `${SITE}/`);
        const imgs = p.blocks.filter((b) => b.kind === 'image');
        assert.strictEqual(imgs.length, 1, 'the 24px icon is not a picture');
        assert.ok(imgs[0].kind === 'image' && imgs[0].src.includes('format=1500w') && imgs[0].alt === 'Our studio on Station Parade' && imgs[0].altFromSite);
        const w = readImportPage(fixture('wix-home'), 'https://www.crumb.example/').blocks.find((b) => b.kind === 'image');
        assert.ok(w && w.kind === 'image' && !w.altFromSite && !/\.jpg$/.test(w.alt), 'a file name is never used as the description');
        assert.ok(w && w.kind === 'image' && w.src.includes('/v1/fit/w_1600,h_1600'), 'not the 147px thumbnail');
        assert.strictEqual(fullSizeImageUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
        assert.ok(p.logo && p.logo.alt === 'Willow & Thread logo');
    });

    await check('a JavaScript-only page reads as (nearly) nothing — it is never filled in', () => {
        const spa = readImportPage(read('tests/fixtures/site-pages/spa-shell.html'), 'https://spa.example/');
        assert.ok(spa.words < 40, `${spa.words} words`);
    });

    await check('the Mystery Shopper\'s fixtures read too (Wix, Squarespace, WordPress) without throwing', () => {
        for (const f of ['wix-local', 'squarespace-weak', 'wordpress-strong', 'webflow-saas', 'bare-html']) {
            const p = readImportPage(read(`tests/fixtures/site-pages/${f}.html`), 'https://example.com/');
            assert.ok(p.blocks.length > 3, f);
        }
    });

    console.log('\nWhich pages, and the address');

    await check('the menu\'s pages in order — never home again, the cart, legal pages, blog posts or other sites', () => {
        const home = readImportPage(fixture('sqsp-home'), `${SITE}/`);
        assert.deepStrictEqual(pickImportPages(home, 10).map((l) => l.href), [`${SITE}/services`, `${SITE}/about-us`, `${SITE}/contact`]);
        assert.strictEqual(pickImportPages(home, 1).length, 1);
    });

    await check('the address they type: https added, junk and credentials refused', () => {
        assert.strictEqual(cleanImportUrl('willowandthread.co.uk'), 'https://willowandthread.co.uk/');
        assert.strictEqual(cleanImportUrl('http://x.example/a#b'), 'http://x.example/a');
        for (const bad of ['', 'not a url', 'ftp://x.example', 'https://user:pw@x.example', 'localhost', 42]) assert.strictEqual(cleanImportUrl(bad), null, String(bad));
    });

    await check('robots.txt: Squarespace\'s default file lets us read pages (its "/*?author=*" is not "Disallow: /")', () => {
        const rules = parseRobots('User-agent: *\nDisallow: /config\nDisallow: /search\nDisallow:/*?author=*\nDisallow:/*&tag=*\nDisallow: /api/\nAllow: /api/ui-extensions/\n', 'bemoreswan-siteimport');
        assert.strictEqual(robotsAllowsPath(rules, '/'), true);
        assert.strictEqual(robotsAllowsPath(rules, '/services'), true);
        assert.strictEqual(robotsAllowsPath(rules, '/blog?author=jo'), false);
        assert.strictEqual(robotsAllowsPath(rules, '/search'), false);
        assert.strictEqual(robotsAllowsPath(rules, '/api/ui-extensions/x'), true, 'the longer Allow wins');
        const anchored = parseRobots('User-agent: *\nDisallow: /*.pdf$\n');
        assert.strictEqual(robotsAllowsPath(anchored, '/menu.pdf'), false);
        assert.strictEqual(robotsAllowsPath(anchored, '/menu.pdf?v=2'), true);
    });

    console.log('\nThe plan and the draft — their words, unchanged');

    const pages = [readPage(`${SITE}/`, 'Home'), readPage(`${SITE}/services`, 'Services'), readPage(`${SITE}/contact`, 'Contact')];
    const { blocks, prices } = numberBlocks(pages);
    const n = (text: string) => blocks.find((b) => 'text' in b.block && b.block.text.startsWith(text))!.n;
    const img = blocks.find((b) => b.block.kind === 'image')!.n;
    const btn = blocks.find((b) => b.block.kind === 'button')!.n;
    const plan = readImportPlan({
        pages: [
            { page: 1, sections: [
                { type: 'hero', headline: n('Alterations and repairs'), subheadline: n('We take up hems'), button: btn, image: img },
                { type: 'features', heading: n('What we do'), items: [{ title: n('Hems —'), body: [] }, { title: n('Zips —'), body: [] }] },
                { type: 'faq', heading: n('Questions'), items: [{ q: n('How long'), a: [n('Most alterations')] }, { q: n('Do I need'), a: [n('For fittings')] }] },
                { type: 'testimonials', heading: null, items: [{ quote: n('“They saved'), name: null, detail: null }] },
            ] },
            { page: 2, sections: [{ type: 'steps', heading: n('How it works'), items: [{ title: n('Bring your'), body: [] }, { title: n('We pin'), body: [] }, { title: n('Collect'), body: [] }] }] },
            { page: 3, sections: [{ type: 'contact', heading: n('Get in touch'), intro: n('Call in, ring') }] },
            { page: 'x', sections: 'nonsense' },
        ],
        skip: [n('Sarah, Knaresborough')],
    })!;

    await check('words that state a price never reach the site — they are listed for Business Information', () => {
        assert.deepStrictEqual(prices, ['Hems from £12, zips from £18.', 'Repairs £10–£40 depending on the job.']);
        assert.ok(!blocks.some((b) => 'text' in b.block && statesPrice(b.block.text)));
        const prompt = buildImportPrompt(pages, blocks, { siteName: 'Willow & Thread', pictures: 'copy', allowed: () => true });
        assert.ok(!prompt.user.includes('£'), 'the model is not even shown them');
    });

    await check('the prompt asks for block numbers only, and says pictures are off when they chose to leave them out', () => {
        const p = buildImportPrompt(pages, blocks, { siteName: 'W', pictures: 'skip', allowed: () => true });
        assert.ok(p.system.includes('You never write, change, shorten or add any words'));
        assert.ok(p.user.includes(`[${n('Alterations and repairs')}] heading (h1): Alterations`));
        assert.ok(p.user.includes('never use picture blocks') && !p.user.includes('"type":"gallery"'));
    });

    await check('the model\'s plan is read defensively: unknown shapes are dropped, not trusted', () => {
        assert.strictEqual(readImportPlan(null), null);
        assert.strictEqual(readImportPlan({ pages: 'x' }), null);
        assert.strictEqual(plan.pages.length, 3, 'the page with no number is dropped');
        assert.deepStrictEqual(readImportPlan({ pages: [{ page: 1, sections: [{ type: 'html', html: '<script>' }, { type: 'text', body: [1, 'two', -3] }] }] })!.pages[0].sections, [{ type: 'text', heading: null, body: [1], image: null }]);
        assert.deepStrictEqual(picturesInPlan(plan, blocks), [img]);
    });

    const built = assembleImport({ current: current(), pages, blocks, plan, assets: new Map([[img, 77]]), maxPages: 5 });
    const def = built.definition;
    const home = def.pages[0];

    await check('the draft is built from the plan: a hero, features, questions, testimonials, steps, a contact form', () => {
        assert.deepStrictEqual(def.pages.map((p) => [p.title, p.slug]), [['Home', ''], ['Services', 'services'], ['Contact', 'contact']]);
        // The "Wedding dresses" item the plan forgot sits where it was read: after the other two.
        assert.deepStrictEqual(home.sections.map((s) => s.type), ['hero', 'features', 'text', 'faq', 'testimonials']);
        const hero = home.sections[0];
        assert.ok(hero.type === 'hero' && hero.props.headline === 'Alterations and repairs, done by hand in Harrogate');
        assert.ok(hero.type === 'hero' && hero.props.primaryCta?.href === '/contact', 'their link to their contact page follows onto the new one');
        assert.ok(hero.type === 'hero' && hero.props.image?.assetId === 77 && hero.props.image.alt === 'Our studio on Station Parade');
        // Blocks the plan forgot go back where they were read: the page's own title before its steps.
        const svc = def.pages[1].sections;
        assert.deepStrictEqual(svc.map((s) => s.type), ['text', 'steps']);
        assert.ok(svc[0].type === 'text' && svc[0].props.heading === 'Our services' && svc[0].props.body === 'Every job is measured, pinned and sewn in our studio.');
    });

    await check('every word on the draft is a word from their site (nothing reworded, nothing invented)', () => {
        assert.deepStrictEqual(draftWordsAllFromSource(def, pages), []);
    });

    await check('nothing silently lost: a block the plan forgot is added as text; what it called clutter is listed', () => {
        const all = JSON.stringify(def.pages);
        assert.ok(all.includes('Wedding dresses — fittings from six months before the day.'), 'the third "What we do" item, not in the plan, is still there');
        assert.ok(all.includes('Every job is measured, pinned and sewn in our studio.'));
        assert.deepStrictEqual(built.leftOut, ['Sarah, Knaresborough']);
    });

    await check('a quote with no name on the old site gets a [placeholder] name — never an invented one', () => {
        const t = home.sections.find((s) => s.type === 'testimonials');
        assert.ok(t && t.type === 'testimonials' && t.props.items[0].name === '[Customer name]');
    });

    await check('the contact form never offers "send me news": enquiries do not go to the Audience', () => {
        const c = def.pages[2].sections.find((s) => s.type === 'contact');
        assert.ok(c && c.type === 'contact' && c.props.offerUpdates === false && c.props.heading === 'Get in touch');
    });

    await check('the public email and phone on their site become the site\'s details; their design is kept', () => {
        assert.strictEqual(def.settings.email, 'hello@willowandthread.example');
        assert.strictEqual(def.settings.phone, '01423 000000');
        assert.strictEqual(def.settings.locality, 'Harrogate');
        assert.deepStrictEqual(def.theme, current().theme);
        assert.strictEqual(home.seo.title, 'Willow & Thread | Alterations in Harrogate');
    });

    await check('no plan at all (the model failed): every non-price word still lands, under its own headings', () => {
        const r = assembleImport({ current: current(), pages, blocks, plan: null, assets: new Map(), maxPages: 5 });
        assert.deepStrictEqual(draftWordsAllFromSource(r.definition, pages), []);
        const all = JSON.stringify(r.definition.pages);
        for (const b of blocks) if ('text' in b.block && b.block.kind !== 'button') assert.ok(all.includes(JSON.stringify(b.block.text).slice(1, -1)), b.block.text);
        assert.strictEqual(r.definition.pages[0].sections[0].type, 'hero');
        assert.ok(!all.includes('£'));
    });

    await check('a feature of the website they switched off is never imported as that kind of section', () => {
        const off = current();
        off.settings.features = [];
        const r = assembleImport({ current: off, pages, blocks, plan, assets: new Map(), maxPages: 5 });
        assert.ok(!r.definition.pages.some((p) => p.sections.some((s) => s.type === 'faq')), 'no questions section');
        assert.ok(JSON.stringify(r.definition.pages).includes('Most alterations are ready in a week.'), 'but its words are kept as text');
    });

    await check('the draft passes the one gate unchanged', () => {
        const again = normaliseSiteDefinition(def, { maxPages: 5 });
        assert.deepStrictEqual(again.definition, def);
    });

    console.log('\nThe whole import');

    await check('copying pictures: only the ones the plan uses (and the logo) are copied into the library', async () => {
        const d = deps({ plan: JSON.parse(JSON.stringify(plan)) });
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current: current(), maxPages: 5 }, d);
        assert.ok(r.ok);
        assert.strictEqual(d.calls.pictures.length, 2);
        assert.ok(d.calls.pictures[0].includes('studio.jpg') && d.calls.pictures[1].includes('logo.png'));
        assert.ok(r.ok && r.definition.theme.logoAssetId === 902 && r.report.pictures.copied === 2 && r.report.pictures.found === 2 && r.report.pictures.undescribed === 0);
    });

    await check('leaving pictures out: nothing is copied and no picture is hot-linked from their old host', async () => {
        const d = deps({ plan: JSON.parse(JSON.stringify(plan)) });
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 5 }, d);
        assert.ok(r.ok);
        assert.strictEqual(d.calls.pictures.length, 0);
        assert.ok(r.ok && !JSON.stringify(r.definition).includes('squarespace-cdn'));
    });

    await check('the report: pages and words read, a page that failed, prices found, the page cap', async () => {
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 5 }, deps({ plan: null }));
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.deepStrictEqual(r.report.pages.map((p) => [p.title, p.read]), [['Home', true], ['Services', true], ['About us', false], ['Contact', true]]);
        assert.strictEqual(r.report.prices.length, 2);
        assert.strictEqual(r.report.contact.email, 'hello@willowandthread.example');
        assert.ok(r.report.hadForm);
    });

    await check('over the plan\'s page cap, the contact page is kept and the rest are listed as not imported', async () => {
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 2 }, deps({ plan: null }));
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.deepStrictEqual(r.definition.pages.map((p) => p.slug), ['', 'contact']);
        assert.deepStrictEqual(r.report.notImported.map((l) => l.title), ['Services', 'About us']);
    });

    await check('a JavaScript-only site: told plainly, no model call, no pictures, no draft', async () => {
        const d = deps({ pages: { 'https://spa.example/': read('tests/fixtures/site-pages/spa-shell.html') } });
        const r = await runImport({ url: 'https://spa.example/', pictures: 'copy', current: current(), maxPages: 5 }, d);
        assert.ok(!r.ok);
        assert.ok(!r.ok && /We could only read a little of your site/.test(r.message) && /Add your own words/.test(r.message) && /Nothing was charged/.test(r.message));
        assert.strictEqual(d.calls.plan, 0);
        assert.strictEqual(d.calls.pictures.length, 0);
    });

    await check('a JavaScript-only site we CAN run: each thin page is read again with its JavaScript run, and imported', async () => {
        const shell = read('tests/fixtures/site-pages/spa-shell.html');
        const d = deps({ plan: null, pages: Object.fromEntries(Object.keys(PAGES).map((u) => [u, shell])) });
        const rendered: string[] = [];
        d.renderHtml = async (url) => {
            rendered.push(url);
            const html = PAGES[url] ?? PAGES[url.replace(/\/$/, '')];
            return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'no' };
        };
        // The shell has no menu; the rendered home page's menu is what finds the other pages.
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 5 }, d);
        assert.ok(r.ok, r.ok ? '' : r.message);
        assert.ok(rendered.includes(`${SITE}/`) && rendered.length > 1);
        assert.ok(r.ok && r.report.wordsRead >= 80);
    });

    await check('a page that already has its words is never run in a browser', async () => {
        const d = deps({ plan: null });
        const rendered: string[] = [];
        d.renderHtml = async (url) => { rendered.push(url); return { ok: false, message: 'no' }; };
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 5 }, d);
        assert.ok(r.ok);
        assert.ok(!rendered.includes(`${SITE}/`));
    });

    await check('a render that fails or finds nothing more leaves the plain read — told plainly, nothing charged', async () => {
        const d = deps({ pages: { 'https://spa.example/': read('tests/fixtures/site-pages/spa-shell.html') } });
        d.renderHtml = async () => { throw new Error('no browser'); };
        const r = await runImport({ url: 'https://spa.example/', pictures: 'copy', current: current(), maxPages: 5 }, d);
        assert.ok(!r.ok && /We could only read a little of your site/.test(r.message));
        assert.strictEqual(d.calls.plan, 0);
    });

    await check('the rendering browser never fetches for itself: every request goes through the SSRF fence', () => {
        const src = read('src/utils/site-js-render.ts');
        assert.ok(src.includes('setRequestInterception(true)'));
        assert.ok(src.includes('safeFetchText(target'));
        assert.ok(!/req\.continue\(\)/.test(src.replace("if (target.startsWith('data:')) { await req.continue().catch(() => {}); return; }", '')), 'only data: URLs continue unfenced');
        assert.ok(src.includes("'WebSocket'"), 'WebSockets are not intercepted, so the page has none');
        const store = read('src/utils/site-import-store.ts');
        assert.ok(store.includes('await renderer.close()'), 'the browser is always closed');
        assert.ok(read('netlify.toml').includes('[functions.draft-site-background]\n  external_node_modules = ["@sparticuz/chromium", "puppeteer-core"]'));
    });

    await check('a site we can\'t reach at all says why, and nothing more', async () => {
        const r = await runImport({ url: 'https://gone.example/', pictures: 'skip', current: current(), maxPages: 5 }, deps({ pages: {} }));
        assert.ok(!r.ok && r.report === null && r.message.includes('404'));
        assert.ok(thinMessage(1, 'square').includes('1 word)'));
    });

    console.log('\nThe same action from the Website tab and the chat');

    const sites = read('netlify/functions/sites.ts');
    const store = read('src/utils/site-import-store.ts');
    const editor = read('src/components/assistant-site-editor.js');
    const reg = read('src/components/disruptive-ui-registry.js');
    const chat = read('src/components/chat-session.js');
    const orch = read('netlify/functions/chat-orchestrator.ts');

    await check('sites.ts import: only their own site, a picture choice required, then the shared draft claim', () => {
        const fn = sites.slice(sites.indexOf("if (action === 'import') {"), sites.indexOf("if (action === 'import_accept')"));
        assert.ok(fn.includes('body.ownSite !== true') && fn.includes("body.pictures !== 'copy' && body.pictures !== 'skip'"));
        assert.ok(fn.indexOf('body.ownSite !== true') < fn.indexOf('startSiteImport('));
        assert.ok(!fn.includes('publish'), 'an import never publishes');
        assert.ok(store.includes('if (!(await claimDraft(db, site.id)))'), 'one AI job at a time, shared with the whole-site draft');
    });

    await check('the import waits for review: only import_accept writes sites.draft, and it is charged once a draft exists', () => {
        const run = store.slice(store.indexOf('export async function runSiteImport'), store.indexOf('export async function acceptImport'));
        assert.ok(!run.includes('draft: '), 'the worker never writes the draft itself');
        assert.ok(run.indexOf("status: 'ready'") < run.indexOf("recordCompletedWork(db, site.organisationId, 'site_draft', 1, site.id)"));
        assert.ok(run.indexOf('if (!outcome.ok)') < run.indexOf('recordCompletedWork('), 'a thin site costs nothing');
        const accept = store.slice(store.indexOf('export async function acceptImport'), store.indexOf('export async function discardImport'));
        assert.ok(accept.includes('verifySiteAssets(') && accept.includes('db.update(sites).set({ draft: checked.definition'));
    });

    await check('pictures are copied into the workspace\'s own library through the SSRF fence — never hot-linked', () => {
        const fn = store.slice(store.indexOf('export async function saveImportedPicture'), store.indexOf('export async function runSiteImport'));
        assert.ok(fn.includes('safeFetchBinary(') && fn.includes('persistBufferToR2(') && fn.includes("provider: 'site_import'") && fn.includes('externalUrl: null'));
        assert.ok(store.includes('fetchSiteHtml(url, CRAWLERS.siteImport'), 'pages through the one fetcher, robots.txt first');
    });

    await check('the Website tab: "Read my site" posts the import; Use / Discard post their actions; the preview can show the import', () => {
        assert.ok(editor.includes("action: 'import', assistantId: state.assistantId, url: f.url, ownSite: true, pictures: f.pictures"));
        assert.ok(editor.includes("action: 'import_accept'") && editor.includes("action: 'import_discard'"));
        assert.ok(editor.includes("${showImport ? '&import=1' : ''}"));
        assert.ok(read('netlify/functions/site-preview.ts').includes("const fromImport = q.import === '1';"));
        assert.ok(editor.includes('data-site-import-own') && editor.includes('name="site-import-pictures"'), 'they confirm it is theirs and choose about pictures');
    });

    await check('the chat: two cards, each sending the same actions through chat-session', () => {
        assert.ok(reg.includes("register('site_import_request', renderSiteImportRequestCard)") && reg.includes("register('site_import_decision', renderSiteImportDecisionCard)"));
        const card = reg.slice(reg.indexOf('function renderSiteImportRequestCard'), reg.indexOf("register('site_import_request'"));
        assert.ok(card.includes("new CustomEvent('site:import'") && card.includes('data-si-own') && card.includes('value="copy"') && card.includes('value="skip"'));
        assert.ok(!/value="copy" checked|value="skip" checked/.test(card), 'the picture choice is the owner\'s, never pre-ticked');
        assert.ok(chat.includes("container.addEventListener('site:import', onSiteImport)") && chat.includes("container.removeEventListener('site:import', onSiteImport)"));
        assert.ok(chat.includes("container.addEventListener('site:importDecision', onSiteImportDecision)") && chat.includes("container.removeEventListener('site:importDecision', onSiteImportDecision)"));
        assert.ok(chat.includes("sitePost({ action: 'import', assistantId") && chat.includes("action: d.decision === 'use' ? 'import_accept' : 'import_discard'"));
        assert.ok(orch.includes('"type": "site_import_request"') && orch.includes('site_import_decision'));
        assert.ok(read('src/utils/site-store.ts').includes('describeImportForChat(importView(await loadImport(db, site.id)), drafting)'), 'the chat sees the import each turn');
    });

    await check('SQL before code: db/z-site-import.sql creates the table the schema mirrors', () => {
        const sql = read('db/z-site-import.sql');
        assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS site_imports') && sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS site_imports_site_uq ON site_imports (site_id)'));
        assert.ok(read('db/schema.ts').includes('export const siteImports = pgTable("site_imports"'));
        assert.ok(read('src/utils/workspace-export.ts').includes('websiteImports: s.siteImports'), 'in their data export');
    });

    console.log(`\n${passed} of ${total} passed.\n`);
}

main();
