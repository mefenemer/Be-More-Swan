// tests/site-embeds.test.ts
// Words inside an embedded HTML box (src/utils/site-embeds.ts) reach Website import and the Mystery
// Shopper. Shaped on kudzucollab.com (2026-11-07): a Wix home page with 35 words of its own, whose
// content is a Wix "Embed HTML" box the server HTML ships as an empty <div id="comp-…">, its address
// only in the page's data file on static.wixstatic.com. No network: every fetch is faked.
//
// Run:  npx tsx tests/site-embeds.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMBED_MAX, iframeEmbedTargets, inlineEmbeds, wixEmbedTargets, wixPageData, type EmbedFetchers } from '../src/utils/site-embeds';
import { extractSitePage } from '../src/utils/site-extract';
import { runImport, thinMessage, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SITE = 'https://www.kudzu.example/';
const EMBED = 'https://www-kudzu-example.filesusr.com/html/ab12_cafe.html';
const JSON_URL = 'https://static.wixstatic.com/sites/ab12_home_143.json.z?v=3';

/** A Wix page as its server sends it: menu, footer, an EMPTY component where the embed box goes. */
const wixPage = (slot = 'comp-box1') => `<!DOCTYPE html><html><head><meta name="generator" content="Wix.com Website Builder"><title>Home - Kudzu</title></head><body>
<header><nav><a href="/">Home</a><a href="/about">About</a><a href="/testimonials">Testimonials</a></nav></header>
<main><section><h2>Nurse-led wellness support for the workplace and the people in it.</h2><div id="${slot}" class="x"></div></section></main>
<footer><a href="/privacy">Privacy Policy</a> letsgrow@kudzu.example</footer>
<script>window.viewerModel = {"siteFeaturesConfigs":{"router":{"pageJsonFileNames":{"ijdas":"ab12_home_143.json","c1vw1":"ab12_testi_131.json"}}},"landingPageId":"ijdas","staticHTMLComponentUrl":"https:\\/\\/www-kudzu-example.filesusr.com\\/"};</script>
</body></html>`;

const pageJson = {
    structure: { components: [{ id: 'comp-sec', components: [{ id: 'comp-box1', dataQuery: '#dataItem-box', componentType: 'wysiwyg.viewer.components.HtmlComponent' }] },
        { id: 'comp-map', dataQuery: '#dataItem-map', componentType: 'wysiwyg.viewer.components.HtmlComponent' }] },
    data: { document_data: {
        'dataItem-box': { type: 'HtmlComponent', url: 'html/ab12_cafe.html', sourceType: 'htmlEmbedded' },
        // A box pointing at someone else's page (a map, a booking widget) is not the owner's words.
        'dataItem-map': { type: 'HtmlComponent', url: 'https://maps.example/embed', sourceType: 'external' },
    } },
};

const PARA = 'Most workplaces have an employee assistance line. Very few have someone consistent that people actually trust, reach before a crisis, and return to over time. That gap is what this practice is here to fill, with steady nurse-led support.';
const embedHtml = `<!DOCTYPE html><html><head><style>body{font:16px serif}</style><script>track()</script></head><body><main>
<h1>Your employees are carrying more than their job description.</h1><p>${PARA}</p>
<h2>Three ways in. One consistent thread.</h2><ul><li>One to one wellness support for people who want to invest in themselves.</li><li>Workplace support for teams.</li><li>Support for cast and crew on set.</li></ul>
<p>${PARA}</p><img src="photo.jpg" alt="Angela"><a href="/book">Book a call</a></main></body></html>`;

function fakes(over: Partial<Record<string, string | null>> = {}): EmbedFetchers & { asked: string[] } {
    const table: Record<string, string | null> = { [EMBED]: embedHtml, [JSON_URL]: JSON.stringify(pageJson), ...over };
    const asked: string[] = [];
    const answer = async (url: string) => {
        asked.push(url);
        const body = table[url];
        return body == null ? { ok: false as const, message: 'That link returned an error (404).' } : { ok: true as const, html: body, finalUrl: url };
    };
    return { asked, html: answer, json: answer };
}

const current = () => starterSite({ name: 'Kudzu', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

async function main() {
    console.log('\nFinding the boxes');

    await check('a Wix page names its data file and the filesusr.com address its boxes come from', () => {
        assert.deepStrictEqual(wixPageData(wixPage()), { jsonUrl: JSON_URL, embedBase: 'https://www-kudzu-example.filesusr.com/' });
        assert.strictEqual(wixPageData('<html><body><p>Not Wix</p></body></html>'), null);
        // An embed origin that isn't Wix's is never trusted to build an address from.
        assert.strictEqual(wixPageData(wixPage().replace('filesusr.com', 'evil.example')), null);
    });

    await check('only "htmlEmbedded" boxes are read, each with the component it fills', () => {
        assert.deepStrictEqual(wixEmbedTargets(pageJson, 'https://www-kudzu-example.filesusr.com/'), [{ url: EMBED, wixComponentId: 'comp-box1' }]);
        assert.deepStrictEqual(wixEmbedTargets(null, 'https://www-kudzu-example.filesusr.com/'), []);
    });

    await check('an <iframe> is read when it is a Wix box or from the page\'s own site — never a map or a video', () => {
        const html = `<iframe src="${EMBED}"></iframe><iframe src="/embed/offer.html"></iframe><iframe src="https://www.youtube.com/embed/x"></iframe><iframe src="https://maps.google.com/x"></iframe>`;
        assert.deepStrictEqual(iframeEmbedTargets(html, 'https://kudzu.example/').map((t) => t.url), [EMBED, 'https://kudzu.example/embed/offer.html']);
    });

    console.log('\nReading them into the page');

    await check('the box\'s words land in its empty component; scripts and styles stay out; addresses made absolute', async () => {
        const r = await inlineEmbeds(wixPage(), SITE, fakes());
        assert.deepStrictEqual([r.found, r.read], [1, 1]);
        assert.ok(/<div id="comp-box1"[^>]*><div data-embedded(="")?>/.test(r.html));
        assert.ok(r.html.includes('Three ways in.') && !r.html.includes('track()') && !r.html.includes('font:16px'));
        assert.ok(r.html.includes('src="https://www-kudzu-example.filesusr.com/html/photo.jpg"'));
        assert.strictEqual((r.html.match(/<main/g) ?? []).length, 1, 'the box\'s own <main> doesn\'t become a second one');
    });

    await check('the Mystery Shopper reads the page as a visitor sees it: thin before, readable after', async () => {
        const before = extractSitePage(wixPage(), SITE);
        const after = extractSitePage((await inlineEmbeds(wixPage(), SITE, fakes())).html, SITE);
        assert.ok(before.thin, 'without the box there is nothing to judge');
        assert.ok(!after.thin && after.wordCount > 100);
        assert.deepStrictEqual(after.hero.h1, ['Your employees are carrying more than their job description.']);
    });

    await check('a box that can\'t be read leaves the page as it was; nothing throws', async () => {
        const r = await inlineEmbeds(wixPage(), SITE, fakes({ [EMBED]: null }));
        assert.deepStrictEqual([r.found, r.read, r.html], [1, 0, wixPage()]);
        const noJson = await inlineEmbeds(wixPage(), SITE, fakes({ [JSON_URL]: 'not json' }));
        assert.deepStrictEqual([noJson.found, noJson.read], [0, 0]);
    });

    await check(`no more than ${EMBED_MAX} boxes are fetched on one page`, async () => {
        const frames = Array.from({ length: EMBED_MAX + 3 }, (_, i) => `<iframe src="/e${i}.html"></iframe>`).join('');
        const f = fakes();
        await inlineEmbeds(`<html><body>${frames}</body></html>`, 'https://kudzu.example/', f);
        assert.strictEqual(f.asked.length, EMBED_MAX);
    });

    console.log('\nWebsite import');

    const TESTI = `<html><head><meta name="generator" content="Wix.com Website Builder"></head><body><main>${Array.from({ length: 6 }, () => `<p>${PARA}</p>`).join('')}</main></body></html>`;
    function importDeps(opts: { json?: boolean } = {}): ImportDeps & { planned: number } {
        const f = fakes();
        const pages: Record<string, string> = { [SITE]: wixPage(), 'https://www.kudzu.example/about': TESTI, 'https://www.kudzu.example/testimonials': TESTI };
        const d: ImportDeps & { planned: number } = {
            planned: 0,
            async fetchHtml(url) { return pages[url] ? { ok: true, html: pages[url], finalUrl: url } : f.html(url); },
            async plan() { d.planned++; return null; },
            async savePicture() { return null; },
        };
        if (opts.json !== false) d.fetchJson = f.json;
        return d;
    }

    await check('the home page\'s embedded words are imported (kudzucollab.com shape)', async () => {
        const d = importDeps();
        const r = await runImport({ url: SITE, pictures: 'skip', current: current(), maxPages: 3 }, d);
        assert.ok(r.ok, r.ok ? '' : r.message);
        const home = r.ok ? r.report.pages[0] : null;
        assert.ok(home && home.words > 60, `home read ${home?.words} words`);
        // Without the page's data file the same home page reads as almost nothing — the box was the content.
        const without = await runImport({ url: SITE, pictures: 'skip', current: current(), maxPages: 3 }, importDeps({ json: false }));
        assert.ok(!without.ok || without.report.pages[0].words < 40);
    });

    await check('a home page whose box we couldn\'t open says so, not "JavaScript" — and nothing is charged', async () => {
        assert.ok(/embedded HTML box/.test(thinMessage(20, 'wix', 1)) && !/JavaScript/.test(thinMessage(20, 'wix', 1)));
        const d2 = importDeps();
        const base = d2.fetchHtml;
        d2.fetchHtml = async (url) => (url === EMBED ? { ok: false, message: '404' } : url === SITE ? base(url) : { ok: false, message: '404' });
        const r2 = await runImport({ url: SITE, pictures: 'skip', current: current(), maxPages: 1 }, d2);
        assert.ok(!r2.ok && /embedded HTML box that we couldn't open/.test(r2.message) && /Nothing was charged/.test(r2.message));
        assert.strictEqual(d2.planned, 0);
    });

    await check('both live readers pass a JSON fetch through robots.txt + the SSRF fence (site-fetch.ts)', () => {
        const root = join(__dirname, '..');
        const read = (p: string) => readFileSync(join(root, p), 'utf8');
        assert.ok(read('src/utils/site-import-store.ts').includes('fetchJson: (url) => fetchSiteJson(url, CRAWLERS.siteImport'));
        assert.ok(read('src/utils/site-audit.ts').includes('json: (u) => fetchSiteJson(u, CRAWLERS.mysteryShopper, opts)'));
        const fetch = read('src/utils/site-fetch.ts');
        assert.ok(fetch.includes('export async function fetchSiteJson') && fetch.includes('robotsAllows(u.host'));
    });

    console.log(`\n${passed} of ${total} passed.\n`);
}

main();
