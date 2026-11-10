// tests/site-import-gaps.test.ts
// The Website import's known gaps, closed (owner, 2026-11-08: "fix all of those so we have fewer
// issues as more users use the Website Assistant"):
//   1. Links inside sentences: [words](/page) in text, drawn through the button gate.
//   2. Long pages fold neighbouring text sections under "### " subheadings instead of losing words.
//   3. A second brand colour for call-to-action buttons.
//   4. Social profile links (footer + sameAs); their form's questions; CSS background pictures.
//   5. Embedded videos and maps become a thumbnail + "Watch the video" / "See us on the map" button.
//   6. A page that is only the Blog Assistant widget switches the hosted blog on instead.
//   7. Old addresses that changed forward (301) to the new page.
//
// Run:  npx tsx tests/site-import-gaps.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImportPage } from '../src/utils/site-extract';
import { assembleImport, numberBlocks, runImport, draftWordsAllFromSource, type ImportDeps, type ReadPage } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit, placeholdersIn } from '../src/utils/site-draft';
import { applySiteOperation, normaliseSiteDefinition, redirectFor, LIMITS, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage, themeCss } from '../src/utils/site-render';
import { linkFirst, mapInlineLinks, plainOf } from '../src/utils/site-rich-text';
import { readImportedLook } from '../src/utils/site-import-theme';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const current = () => starterSite({ name: 'Gap Test Co', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@account.example' }, themeFromBrandKit(null));
const ctx = { preview: false, reportUrl: '/report', creditUrl: null } as never;
const withText = (body: string): SiteDefinition => {
    const d = current();
    d.pages[0].sections.push({ id: 'sx', type: 'text', props: { heading: 'About', body, image: null, imageSide: 'right' }, look: { background: 'auto', columns: 'auto', menuLabel: null } } as never);
    return normaliseSiteDefinition(d).definition;
};
const SITE = 'https://gap.example';
const shell = (main: string, extra = '') => `<!doctype html><html><head><title>Gap Test Co</title></head><body>
<header><nav><a href="/">Home</a><a href="/services/coaching">Coaching</a><a href="/contact">Contact</a><a href="/news">News</a></nav></header>
<main>${main}</main><footer><a href="https://www.instagram.com/gaptest">Instagram</a> <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a> <a href="https://www.linkedin.com/company/gaptest/">LinkedIn</a>${extra}</footer></body></html>`;

async function main() {
    console.log('1. Links inside sentences');

    await check('the format: links found and moved, words alone for checks, placeholders still placeholders', () => {
        assert.strictEqual(plainOf('Read our [course notes](/notes) first.\n### Who'), 'Read our course notes first.\nWho');
        assert.strictEqual(mapInlineLinks('a [b](/x) c', (h) => (h === '/x' ? '/y' : null)), 'a [b](/y) c');
        assert.strictEqual(mapInlineLinks('a [b](/x) c', () => null), 'a b c');
        assert.strictEqual(linkFirst('see notes, then notes', 'notes', '/n'), 'see [notes](/n), then notes');
        const d = withText('Call [Your name] or read [our notes](/contact).');
        assert.deepStrictEqual(placeholdersIn(d).map((p) => p.text).filter((t) => t.includes('Your name') || t.includes('notes')), ['[Your name]']);
    });

    await check('drawn as a link only when safe and the page exists; subheadings drawn as headings; everything escaped', () => {
        const html = renderSitePage(withText('Read [our notes](/contact) or [this](javascript:void0) or [gone](/nowhere) or [mail](mailto:a@b.co).\n\n### Who it\'s <for>\n\nEveryone.'), '/', ctx).html;
        assert.ok(html.includes('Read <a href="/contact">our notes</a> or this or gone or <a href="mailto:a@b.co">mail</a>.'), 'safe links only');
        assert.ok(html.includes('<h3>Who it&#39;s &lt;for&gt;</h3>') || html.includes('<h3>Who it\'s &lt;for&gt;</h3>'));
        assert.ok(!html.includes('javascript:'));
    });

    await check('combining pages turns an inline link to a moved page into a jump down the page', () => {
        const d = current();
        d.pages[0].sections.push({ id: 'sx', type: 'text', props: { heading: null, body: 'See [contact us](/contact).', image: null, imageSide: 'right' }, look: { background: 'auto', columns: 'auto', menuLabel: null } } as never);
        const r = applySiteOperation(normaliseSiteDefinition(d).definition, { op: 'combine_pages' });
        assert.ok(r.ok);
        const body = JSON.stringify((r as { definition: SiteDefinition }).definition.pages[0].sections);
        assert.ok(/See \[contact us\]\(#s\d+\)/.test(body), body.slice(0, 400));
    });

    await check('the import keeps a link inside a sentence, pointing at the new page; one to a page not imported stays words', () => {
        const home = shell('<h1>Gap Test Co</h1><p>Read about our <a href="/services/coaching">coaching programme</a> and our <a href="/elsewhere">history</a> today.</p>');
        const pages: ReadPage[] = [
            { url: `${SITE}/`, menuLabel: 'Home', page: readImportPage(home, `${SITE}/`) },
            { url: `${SITE}/services/coaching`, menuLabel: 'Coaching', page: readImportPage(shell('<h1>Coaching</h1><p>One to one sessions for leaders who want to grow.</p>'), `${SITE}/services/coaching`) },
        ];
        const { blocks } = numberBlocks(pages);
        const built = assembleImport({ current: current(), pages, blocks, plan: null, assets: new Map(), maxPages: 5 });
        const all = JSON.stringify(built.definition.pages);
        assert.ok(all.includes('Read about our [coaching programme](/coaching) and our history today.'), all.slice(0, 600));
        assert.deepStrictEqual(draftWordsAllFromSource(built.definition, pages), []);
    });

    console.log('\n2. Long pages');

    await check('a page with too many sections folds neighbouring text under subheadings — no words lost', () => {
        const paras = Array.from({ length: 30 }, (_, i) => `<h2>Part ${i + 1}</h2><p>Paragraph number ${i + 1} of the long page, with enough words to read as content.</p>`).join('');
        const pages: ReadPage[] = [{ url: `${SITE}/`, menuLabel: 'Home', page: readImportPage(shell(`<h1>Long page</h1>${paras}`), `${SITE}/`) }];
        const { blocks } = numberBlocks(pages);
        const built = assembleImport({ current: current(), pages, blocks, plan: null, assets: new Map(), maxPages: 5 });
        assert.ok(built.definition.pages[0].sections.length <= LIMITS.sectionsPerPage);
        assert.deepStrictEqual(built.notCarried, []);
        const all = JSON.stringify(built.definition.pages);
        for (let i = 1; i <= 30; i++) assert.ok(all.includes(`Paragraph number ${i} of the long page`), `paragraph ${i}`);
        assert.ok(all.includes('### Part '), 'folded headings become subheadings');
    });

    console.log('\n3. A second colour');

    await check('read from their buttons (Tailwind) or a --secondary variable; the CTA button takes it when it stands out', () => {
        const tw = `<html><head><meta name="theme-color" content="#1d5b5a"><script>tailwind.config = { theme: { extend: { colors: { brand: { 700: '#1d5b5a' }, clay: { 500: '#d0653b' }, sand: { 50: '#fbf9f5' } } } } };</script></head>
<body class="bg-sand-50"><main><a class="rounded-full bg-clay-500 px-5" href="/book">Book</a><a class="rounded-full bg-brand-700 px-5" href="/x">X</a><a class="rounded-full bg-clay-500 px-5" href="/y">Y</a></main></body></html>`;
        assert.strictEqual(readImportedLook(tw, 'https://x.example/').secondaryColor, '#d0653b');
        assert.strictEqual(readImportedLook('<html><body></body></html>', 'https://x.example/', ':root{--brand-primary:#1d5b5a;--color-secondary:#d0653b}').secondaryColor, '#d0653b');
        const t = normaliseSiteDefinition({ ...current(), theme: { ...current().theme, primaryColor: '#1d5b5a', secondaryColor: '#d0653b' } }).definition.theme;
        assert.strictEqual(t.secondaryColor, '#d0653b');
        assert.ok(themeCss(t).includes('.cta .btn{background:#d0653b;'));
        assert.ok(!themeCss({ ...t, secondaryColor: '#1d5b5b' }).includes('.cta .btn{background:#1d5b5b'), 'too close to the band: not used');
    });

    console.log('\n4. Social links, form questions, background pictures');

    const contactHtml = shell(`<h1>Contact</h1><p>Send us a message and we will reply soon.</p>
<form><label for="n">Your name *</label><input id="n" name="name"><label for="o">Organisation</label><input id="o" name="org"><textarea name="message" placeholder="Your message"></textarea><input type="hidden" name="bot-field"><button type="submit">Send</button></form>`);
    const homeHtml = shell(`<section style="background-image:url('/img/hero.jpg')"><h1>Gap Test Co</h1><p>Training and coaching for teams across the north.</p></section>
<div class="bg-[url('/img/band.webp')]"><p>Our band picture sits behind these words for a reason.</p></div>`);

    await check('social profiles are read from anywhere on the page (share buttons are not profiles)', () => {
        const p = readImportPage(homeHtml, `${SITE}/`);
        assert.deepStrictEqual(p.socialLinks, ['https://www.instagram.com/gaptest', 'https://www.linkedin.com/company/gaptest/']);
    });

    await check('their form\'s questions are listed; the new form asks for a phone only if theirs did', () => {
        const pages: ReadPage[] = [
            { url: `${SITE}/`, menuLabel: 'Home', page: readImportPage(homeHtml, `${SITE}/`) },
            { url: `${SITE}/contact`, menuLabel: 'Contact', page: readImportPage(contactHtml, `${SITE}/contact`) },
        ];
        assert.deepStrictEqual(pages[1].page.formFields, ['Your name', 'Organisation', 'Your message']);
        const { blocks } = numberBlocks(pages);
        const def = assembleImport({ current: current(), pages, blocks, plan: null, assets: new Map(), maxPages: 5 }).definition;
        const form = def.pages.flatMap((p) => p.sections).find((s) => s.type === 'contact');
        assert.ok(form && form.type === 'contact' && form.props.askPhone === false);
        assert.deepStrictEqual(def.settings.socialLinks, ['https://www.instagram.com/gaptest', 'https://www.linkedin.com/company/gaptest/']);
    });

    await check('the footer links their profiles and search engines are told (sameAs); only real social sites are kept', () => {
        const d = normaliseSiteDefinition({ ...current(), settings: { ...current().settings, socialLinks: ['https://www.instagram.com/gaptest', 'https://evil.example/x', 'javascript:alert(1)'] } }).definition;
        assert.deepStrictEqual(d.settings.socialLinks, ['https://www.instagram.com/gaptest']);
        const html = renderSitePage(d, '/', { ...(ctx as object), origin: 'https://gap.example' } as never).html;
        assert.ok(html.includes('<a href="https://www.instagram.com/gaptest" rel="noopener me">Instagram</a>'));
        assert.ok(html.includes('"sameAs":["https://www.instagram.com/gaptest"]'));
    });

    await check('a picture drawn as a CSS background is read like any picture', () => {
        const imgs = readImportPage(homeHtml, `${SITE}/`).blocks.filter((b) => b.kind === 'image').map((b) => (b as { src: string }).src);
        assert.ok(imgs.some((s) => s.endsWith('/img/hero.jpg')) && imgs.some((s) => s.endsWith('/img/band.webp')), imgs.join(' '));
    });

    console.log('\n5. Embedded videos and maps');

    await check('a YouTube video becomes its thumbnail and a watch button; a map a map button; nothing is framed', () => {
        const p = readImportPage(shell('<h1>Watch</h1><p>Here is our story told in a short film.</p><iframe src="https://www.youtube-nocookie.com/embed/AbC123xyz_0" title="Our story"></iframe><iframe src="https://www.google.com/maps/embed?pb=!1m18"></iframe><iframe src="https://tracker.example/x"></iframe>'), `${SITE}/`);
        const pic = p.blocks.find((b) => b.kind === 'image') as { src: string; alt: string };
        assert.strictEqual(pic.src, 'https://i.ytimg.com/vi/AbC123xyz_0/hqdefault.jpg');
        assert.strictEqual(pic.alt, 'Our story');
        const btns = p.blocks.filter((b) => b.kind === 'button').map((b) => [(b as { text: string }).text, (b as { href: string }).href]);
        assert.deepStrictEqual(btns, [['Watch the video', 'https://www.youtube.com/watch?v=AbC123xyz_0'], ['See us on the map', 'https://www.google.com/maps?pb=!1m18']]);
        assert.ok(!read('netlify/functions/site-serve.ts').includes('frame-src'), 'hosted pages still frame nothing');
    });

    console.log('\n6. Their Blog Assistant page');

    await check('a page that is only the blog widget turns the hosted blog on under their menu word; links to it go to /blog', async () => {
        const pagesHtml: Record<string, string> = {
            [`${SITE}/`]: shell(`<h1>Gap Test Co</h1><p>${'Training and coaching for teams across the north of England. '.repeat(12)}</p><p>Read our <a href="/news">latest news</a> every week.</p>`),
            [`${SITE}/news`]: shell('<h1>News</h1><div id="bms-blog"></div><script src="https://bemoreswan.com/widget.js" data-key="k"></script>'),
            [`${SITE}/contact`]: contactHtml,
        };
        const deps: ImportDeps = {
            async fetchHtml(url) { const h = pagesHtml[url]; return h ? { ok: true, html: h, finalUrl: url } : { ok: false, message: '404' }; },
            async plan() { return null; }, async savePicture() { return null; },
        };
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 5 }, deps);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.deepStrictEqual(r.definition.settings.blog, { enabled: true, menuLabel: 'News' });
        assert.ok(!r.definition.pages.some((p) => p.slug === 'news'), 'no empty News page');
        assert.ok(JSON.stringify(r.definition.pages).includes('[latest news](/blog)'));
        assert.deepStrictEqual(r.definition.redirects?.find((x) => x.from === '/news'), { from: '/news', to: '/blog' });
        assert.ok(r.report.pages.some((p) => p.title === 'News' && /Blog Assistant posts/.test(p.note ?? '')));
    });

    console.log('\n7. Old addresses');

    await check('an imported page whose address changed forwards from the old one; the gate keeps only redirects to real pages', () => {
        const pages: ReadPage[] = [
            { url: `${SITE}/`, menuLabel: 'Home', page: readImportPage(shell('<h1>Gap Test Co</h1><p>Training and coaching for teams.</p>'), `${SITE}/`) },
            { url: `${SITE}/services/coaching`, menuLabel: 'Coaching', page: readImportPage(shell('<h1>Coaching</h1><p>One to one sessions for leaders.</p>'), `${SITE}/services/coaching`) },
        ];
        const def = assembleImport({ current: current(), pages, blocks: numberBlocks(pages).blocks, plan: null, assets: new Map(), maxPages: 5 }).definition;
        assert.deepStrictEqual(def.redirects, [{ from: '/services/coaching', to: '/coaching' }]);
        assert.strictEqual(redirectFor(def, '/Services/Coaching/'), '/coaching');
        assert.strictEqual(redirectFor(def, '/services/coaching.html'), '/coaching');
        assert.strictEqual(redirectFor(def, '/nope'), null);
        const bad = normaliseSiteDefinition({ ...def, redirects: [{ from: '/a', to: '/missing' }, { from: '/coaching', to: '/' }, { from: '/_book', to: '/' }, { from: '/b', to: '/coaching' }] }).definition;
        assert.deepStrictEqual(bad.redirects, [{ from: '/b', to: '/coaching' }]);
    });

    await check('served as a 301 before "page not found"; owners see and remove them in Details; the chat can set them', () => {
        const serve = read('netlify/functions/site-serve.ts');
        assert.ok(serve.includes('const moved = redirectFor(definition, path);') && serve.includes('statusCode: 301, headers: { Location: moved'));
        assert.ok(serve.indexOf('const moved = redirectFor') < serve.indexOf('const page = renderSitePage(definition, path'));
        const js = read('src/components/assistant-site-editor.js');
        assert.ok(js.includes('Old addresses that forward here') && js.includes("op: 'set_redirects', redirects: keep"));
        assert.ok(read('netlify/functions/sites.ts').includes("'set_redirects'"));
        assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('{"op":"set_redirects"'));
        assert.ok(read('src/utils/site-store.ts').includes('Old addresses forwarding to a page (set_redirects)'));
        const r = applySiteOperation(normaliseSiteDefinition({ ...current(), redirects: [{ from: '/old', to: '/contact' }] }).definition, { op: 'set_redirects', redirects: [] });
        assert.ok(r.ok && !(r as { definition: SiteDefinition }).definition.redirects);
    });

    await check('the editor and chat know the text marks, the second colour and social links', () => {
        const js = read('src/components/assistant-site-editor.js');
        assert.ok(js.includes('use the buttons for bold, italics, lists, links and subheadings')); // 2026-11-10: the formatting bar (site-text-formatting.test.ts)
        assert.ok(js.includes('data-theme="secondaryColor"') && js.includes('data-site-social'));
        const chat = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(chat.includes('[words](/page) is a link inside a sentence') && chat.includes('"secondaryColor":"#rrggbb"|null') && chat.includes('"socialLinks":['));
    });

    console.log(`\n${passed}/${total} passed`);
}
void main();
