// tests/site-design-settings.test.ts
// More design settings for hosted sites (owner, 2026-11-08, option 1): still a closed set of tokens the
// gate checks — never raw CSS — so every site stays safe, readable and editable by chat:
//   card pictures · button style · card style · heading / header / footer colours · gradient backgrounds,
// in Design and the chat, and read from an imported site.
//
// Run:  npx tsx tests/site-design-settings.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetIdsIn, markVideos, normaliseSiteDefinition, withoutAssets, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage, themeCss } from '../src/utils/site-render';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { readImportedLook, themeWithLook } from '../src/utils/site-import-theme';
import { readImportPlan, picturesInPlan } from '../src/utils/site-import';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const base = () => starterSite({ name: 'Design Co', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@account.example' }, themeFromBrandKit(null));
const withCards = (items: unknown[]): SiteDefinition => {
    const d = base();
    d.pages[0].sections.push({ id: 'sf', type: 'features', props: { heading: 'Courses', intro: null, items }, look: { background: 'gradient', columns: 'auto', menuLabel: null } } as never);
    return normaliseSiteDefinition(d).definition;
};
const ctx = { preview: false, reportUrl: '/r', creditUrl: null, assetUrl: (id: number) => `https://cdn.example/a/${id}.jpg` } as never;

console.log('Card pictures');

check('a card keeps its picture (library or https, with a description); a picture without one is left out', () => {
    const d = withCards([{ title: 'A', body: 'x', image: { assetId: 7, alt: 'Course A' } }, { title: 'B', body: 'y', image: { url: 'https://img.example/b.jpg', alt: '' } }, { title: 'C', body: 'z', image: { url: 'http://img.example/c.jpg', alt: 'C' } }]);
    const items = (d.pages[0].sections.find((s) => s.type === 'features')!.props as { items: Array<{ image?: unknown }> }).items;
    assert.deepStrictEqual(items[0].image, { url: '', alt: 'Course A', assetId: 7 });
    assert.strictEqual(items[1].image, undefined);
    assert.strictEqual(items[2].image, undefined);
});

check('card pictures are owned, removed and kept as pictures like every other picture', () => {
    const d = withCards([{ title: 'A', body: 'x', image: { assetId: 7, alt: 'Course A' } }]);
    assert.ok(assetIdsIn(d).includes(7));
    const gone = withoutAssets(d, new Set([7]));
    assert.strictEqual((gone.pages[0].sections.find((s) => s.type === 'features')!.props as { items: Array<{ image?: unknown }> }).items[0].image, undefined);
    const vid = markVideos(d, new Set([7]));
    assert.strictEqual(vid.removed, 1, 'a video is never a card picture');
});

check('drawn across the top of the card; the import plan can give a card its picture', () => {
    const html = renderSitePage(withCards([{ title: 'A', body: 'x', image: { assetId: 7, alt: 'Course <A>' } }]), '/', ctx).html;
    assert.ok(html.includes('<div class="card"><img class="ci" src="https://cdn.example/a/7.jpg" alt="Course &lt;A&gt;" loading="lazy"><h3>A</h3>'));
    const plan = readImportPlan({ pages: [{ page: 1, sections: [{ type: 'features', items: [{ title: 2, body: [3], image: 1 }] }] }] })!;
    assert.deepStrictEqual(picturesInPlan(plan, [{ n: 1, page: 0, block: { kind: 'image', src: 'https://x/1.jpg', alt: 'a', altFromSite: true } }] as never), [1]);
});

console.log('\nStyles and colours');

check('buttons, cards, headings, header and footer: only what is set is drawn, so older sites look the same', () => {
    const plain = themeCss(base().theme);
    assert.ok(!plain.includes('.btn{border-radius:999px}') && !plain.includes('.card{border-color:transparent;box-shadow') && !plain.includes('.hd{background:') && !plain.includes('h1,h2,h3{color:'));
    const t = normaliseSiteDefinition({ ...base(), theme: { ...base().theme, buttonStyle: 'pill', cardStyle: 'shadow', headingColor: '#1d5b5a', headerColor: '#183d3c', footerColor: '#183d3c' } }).definition.theme;
    const css = themeCss(t);
    assert.ok(css.includes('.btn{border-radius:999px}'));
    assert.ok(css.includes('.card{border-color:transparent;box-shadow:'));
    assert.ok(css.includes('h1,h2,h3{color:#1d5b5a}'));
    assert.ok(css.includes('.hd{background:#183d3c;color:#ffffff') || css.includes('.hd{background:#183d3c;color:#fff'), 'readable words on a dark header');
    assert.ok(css.includes('.ft{background:#183d3c;'));
});

check('outlined buttons never vanish on a coloured band; a heading colour that can\'t be read is refused', () => {
    const t = normaliseSiteDefinition({ ...base(), theme: { ...base().theme, buttonStyle: 'outline' } }).definition.theme;
    assert.ok(themeCss(t).includes(':where(section:not(.band):not(.cta):not(.banner):not(.cover)) .btn:not(.s){background:transparent'));
    const warnings: string[] = [];
    const r = normaliseSiteDefinition({ ...base(), theme: { ...base().theme, backgroundColor: '#ffffff', headingColor: '#fefefe' } });
    warnings.push(...r.warnings);
    assert.strictEqual(r.definition.theme.headingColor, undefined);
    assert.ok(warnings.some((w) => /heading colour/.test(w)));
    const cleared = normaliseSiteDefinition({ ...base(), theme: { ...t, buttonStyle: null } }).definition.theme;
    assert.strictEqual(cleared.buttonStyle, undefined, 'null clears a setting');
});

check('a section can take a soft gradient of the site\'s colours', () => {
    const d = withCards([{ title: 'A', body: 'x' }]);
    assert.strictEqual(d.pages[0].sections.find((s) => s.type === 'features')!.look?.background, 'gradient');
    assert.ok(renderSitePage(d, '/', ctx).html.includes('<section class="grad"'));
    assert.ok(themeCss(d.theme).includes('.grad{background:linear-gradient(135deg,'));
});

console.log('\nRead from an imported site');

check('Tailwind: pill buttons, shadowed cards, a coloured footer and heading colour come across', () => {
    const html = `<html><head><script>tailwind.config = { theme: { extend: { colors: { brand: { 700: '#1d5b5a', 900: '#183d3c' }, sand: { 50: '#fbf9f5' }, ink: { 800: '#2b2b2b' } } } } };</script></head>
<body class="bg-sand-50 text-ink-800"><header class="bg-sand-50"><nav><a class="px-3 rounded-lg" href="/">Home</a></nav></header>
<main><h1 class="text-brand-700">Hello</h1><article class="rounded-2xl p-6 shadow-lg"><h3>Card</h3></article><article class="rounded-2xl p-6 shadow-lg"><h3>Card 2</h3></article>
<a class="rounded-full bg-brand-700 px-6" href="/a">A</a><a class="rounded-full bg-brand-700 px-6" href="/b">B</a></main>
<footer class="bg-brand-900 text-white"><p>© Design Co</p></footer></body></html>`;
    const l = readImportedLook(html, 'https://x.example/');
    assert.deepStrictEqual([l.buttonStyle, l.cardStyle, l.headingColor, l.headerColor, l.footerColor], ['pill', 'shadow', '#1d5b5a', null, '#183d3c']);
    const t = themeWithLook(base().theme, l);
    assert.deepStrictEqual([t.buttonStyle, t.cardStyle, t.footerColor], ['pill', 'shadow', '#183d3c']);
});

check('plain CSS: an outlined button, a bordered card and header/footer colours from their rules', () => {
    const html = '<html><body><header><p>Logo</p></header><main><h1>Hi</h1><a class="border px-4" href="/a">A</a><a class="border px-4" href="/b">B</a></main><footer><p>x</p></footer></body></html>';
    const css = 'body{background:#ffffff;color:#222222}header{background-color:#0f172a}footer{background:#334155}.card{border:1px solid #ddd}';
    const l = readImportedLook(html, 'https://x.example/', css);
    assert.deepStrictEqual([l.buttonStyle, l.cardStyle, l.headerColor, l.footerColor], ['outline', 'bordered', '#0f172a', '#334155']);
});

console.log('\nDesign and chat');

check('Design offers every setting; cards take a picture in the editor; the chat knows them all', () => {
    const js = read('src/components/assistant-site-editor.js');
    for (const k of ['data-theme="buttonStyle"', 'data-theme="cardStyle"', "['headingColor', 'Heading colour'", "['headerColor', 'Header colour'", "['footerColor', 'Footer colour'", "['gradient', 'Soft gradient of your colours']", "['image', 'image', 'Picture (optional)']", 'data-site-item-pick', 'data-theme-off']) assert.ok(js.includes(k), k);
    const chat = read('netlify/functions/chat-orchestrator.ts');
    for (const k of ['"buttonStyle":"solid|outline|pill"', '"cardStyle":"bordered|shadow|flat"', '"headingColor":"#rrggbb"|null', '"background":"auto|plain|soft|brand|gradient"', 'image:{assetId,alt}|null}]} — "link" is the card']) assert.ok(chat.includes(k), k);
});

console.log(`\n${passed}/${total} passed`);
