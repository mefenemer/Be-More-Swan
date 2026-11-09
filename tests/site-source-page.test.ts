// tests/site-source-page.test.ts — words from a page of the owner's CURRENT website onto a page of the
// new one (src/utils/site-source-page.ts, sites.ts `words` with sourceUrl, the chat's site_words card).
//
// WHY THIS EXISTS. Prod 2026-11-08 (Restorative Futures, org 41): the import had left 5 pages out,
// the chat added them empty, and asked to "take the wording from my existing website" it said it
// couldn't. Their page addresses were also cut at 40 characters
// ("restorative-practice-building-relationsh"), so old links would break once their domain moved.
//
// Run:  npx tsx tests/site-source-page.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isOwnSitePage, sameSiteHost, sourcePageText } from '../src/utils/site-source-page';
import { readImportPage } from '../src/utils/site-extract';
import { wordsToBlocks } from '../src/utils/site-words';
import { LIMITS, slugify } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

check('only their own site: www-insensitive, other hosts refused', () => {
    assert.ok(sameSiteHost('https://restorativefutures.co.uk/faqs', 'https://www.restorativefutures.co.uk/'));
    assert.ok(isOwnSitePage('https://www.example.co.uk/about', [null, 'https://example.co.uk']));
    assert.ok(!isOwnSitePage('https://someone-else.co.uk/about', ['https://example.co.uk', null]));
    assert.ok(!isOwnSitePage('https://example.co.uk.evil.test/about', ['https://example.co.uk']));
    assert.ok(!isOwnSitePage('https://example.co.uk/about', [null, undefined]));
});

const PAGE = `<!doctype html><html><head><title>Conferencing skills</title></head><body>
<header><nav><a href="/">Home</a><a href="/about-us">About Us</a><a href="/contact">Contact</a></nav></header>
<main>
<h1>Restorative Practice - Conferencing Skills</h1>
<p>A one-day course for practitioners who lead restorative conferences with confidence and care.</p>
<img src="/pic.jpg" alt="A training room">
<h2>Who it is for</h2>
<ul><li>Youth justice workers</li><li>School pastoral staff</li></ul>
<p>£145 per delegate, including lunch.</p>
<a class="btn" href="/contact">Book now</a>
</main>
<footer><p>© 2026 Restorative Futures</p></footer>
</body></html>`;

check('their words in order, one block each; pictures, buttons and prices left out', () => {
    const page = readImportPage(PAGE, 'https://restorativefutures.co.uk/restorative-practice-conferencing-skills');
    const { text, prices } = sourcePageText(page);
    assert.ok(text.includes('Restorative Practice - Conferencing Skills'), text);
    assert.ok(text.includes('A one-day course for practitioners who lead restorative conferences with confidence and care.'));
    assert.ok(text.indexOf('Who it is for') < text.indexOf('Youth justice workers'));
    assert.ok(!text.includes('£145'), 'price left out');
    assert.strictEqual(prices, 1);
    assert.ok(!text.includes('Book now') && !text.includes('A training room'), 'buttons and pictures are not words');
    // wordsToBlocks keeps each heading as its own block — never joined to the paragraph under it.
    const blocks = wordsToBlocks(text);
    assert.ok(blocks.includes('Who it is for'), JSON.stringify(blocks));
    assert.ok(blocks.includes('Youth justice workers') && blocks.includes('School pastoral staff'));
});

check('an empty page gives no text (the server then says to paste the words)', () => {
    const page = readImportPage('<html><body><div id="app"></div></body></html>', 'https://example.co.uk/');
    assert.strictEqual(sourcePageText(page).text, '');
});

check('page addresses keep their full length (old links survive a domain move)', () => {
    assert.ok(LIMITS.slug >= 80);
    for (const s of ['restorative-practice-building-relationships', 'restorative-practice-online-reflection-post-training', 'restorative-practice-community-panel-member-training']) {
        assert.strictEqual(slugify(s), s);
    }
});

check('wired: sites.ts words reads sourceUrl through readOwnSitePage, before quote', () => {
    const src = read('netlify/functions/sites.ts');
    const at = src.indexOf("if (action === 'words') {");
    const win = src.slice(at, at + 4000);
    assert.ok(win.includes('const fromSite = await readOwnSitePage(db, site, body.sourceUrl);'));
    assert.ok(win.indexOf('body.sourceUrl') < win.indexOf('quoteFromChat'));
    const store = read('src/utils/site-import-store.ts');
    assert.ok(store.includes('if (!isOwnSitePage(url, [org?.websiteUrl, imported?.sourceUrl])) {'), 'own site only');
    assert.ok(store.includes('const r = await fetchSiteHtml(url, CRAWLERS.siteImport,'), 'robots + SSRF fence');
});

check('wired: the card and the chat client carry sourceUrl; the prompt offers it', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes('pageId, attachmentId, quote, sourceUrl, note,'));
    assert.ok(reg.includes('(attachmentId || quote || sourceUrl)'));
    const chat = read('src/components/chat-session.js');
    assert.ok(chat.includes("sourceUrl: d.sourceUrl || null, chatSessionId"));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('WORDS FROM THEIR CURRENT WEBSITE.'));
    assert.ok(orch.includes('never say you can\'t take words from their website'));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
