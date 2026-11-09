// tests/site-import-links.test.ts
// Links survive a Website import (Restorative Futures, 2026-11-08): their home page's course cards
// had "Read more" links to each course page, and buttons like "Discover Our Courses" — all plain
// <a> tags with Tailwind utility classes, no "btn" class. The import read them as loose words, and a
// feature card had nowhere to keep a link. Now:
//   1. A link standing on its own is a button block whatever its class; a link inside a sentence is not.
//   2. A card keeps its own link (features/steps item `link`), drawn under its words and checked like any button.
//   3. A hero keeps two buttons; a call-to-action band keeps its button; a button with no place is listed.
//   4. The editor and the chat both know card links.
//
// Run:  npx tsx tests/site-import-links.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImportPage } from '../src/utils/site-extract';
import { assembleImport, buildImportPrompt, draftWordsAllFromSource, numberBlocks, readImportPlan, type ReadPage } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { applySiteOperation, normaliseSiteDefinition, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const SITE = 'https://restorative.example';
const shell = (main: string) => `<!doctype html><html><head><title>Restorative Example</title></head><body>
<header><nav><a class="nav-link px-3" href="/">Home</a><a class="nav-link px-3" href="/our-courses">Our Courses</a><a class="nav-link px-3" href="/building-relationships">Building relationships</a><a class="nav-link px-3" href="/contact">Contact Us</a></nav></header>
<main>${main}</main><footer><a href="/contact">Contact Us</a></footer></body></html>`;
const HOME = shell(`
<section><h1>Restorative practice training for schools</h1>
  <p>Practical courses that help staff build relationships.</p>
  <div class="mt-8 flex gap-3"><a class="inline-flex rounded-full bg-brand-700 px-7 py-3.5" href="/our-courses">Discover Our Courses</a><a class="inline-flex rounded-full border px-7 py-3.5" href="/contact">Get in Touch</a></div>
</section>
<section><h2>Our courses</h2>
  <div class="grid">
    <article class="rounded-2xl"><div class="p-7"><h3>Building Relationships</h3><p>A working-with approach for every professional.</p>
      <a class="mt-6 inline-flex text-sm font-semibold" href="/building-relationships">Read more <svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></a></div></article>
    <article class="rounded-2xl"><div class="p-7"><h3>Conferencing Skills</h3><p>Facilitate restorative meetings with confidence.</p>
      <a class="mt-6 inline-flex text-sm font-semibold" href="/conferencing-skills">Read more</a></div></article>
  </div>
</section>
<section><p>Read our <a href="/building-relationships">course notes</a> before you book.</p>
  <div><span>Email:</span> <a href="mailto:hello@restorative.example">hello@restorative.example</a></div>
  <p><a class="inline-flex text-sm" href="/testimonials">Read more testimonials</a></p>
</section>
<section><h2>Ready to book?</h2><p>Places fill up each term.</p>
  <div><a class="inline-flex rounded-full px-7" href="/contact">Contact us</a></div>
</section>`);
const COURSE = shell(`<h1>Building Relationships</h1><p>A one-day course on working with people, not doing to them.</p>
<p><a class="inline-flex text-sm" href="/our-courses">See all courses</a></p>`);
const CONTACT = shell('<h1>Contact us</h1><p>We reply within two working days.</p>');

const pages: ReadPage[] = [
    { url: `${SITE}/`, menuLabel: 'Home', page: readImportPage(HOME, `${SITE}/`) },
    { url: `${SITE}/building-relationships`, menuLabel: 'Building relationships', page: readImportPage(COURSE, `${SITE}/building-relationships`) },
    { url: `${SITE}/contact`, menuLabel: 'Contact Us', page: readImportPage(CONTACT, `${SITE}/contact`) },
];
const { blocks } = numberBlocks(pages);
const n = (text: string, page?: number) => {
    const b = blocks.find((x) => 'text' in x.block && x.block.text === text && (page === undefined || x.page === page));
    if (!b) throw new Error(`no block "${text}" — have: ${blocks.map((x) => ('text' in x.block ? x.block.text : x.block.kind)).join(' | ')}`);
    return b.n;
};
const current = () => starterSite({ name: 'Restorative Example', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

async function main() {
    console.log('Reading the links on their pages');

    await check('a link standing on its own is a button block, whatever its classes (Tailwind "Read more", "Discover Our Courses")', () => {
        const home = pages[0].page.blocks;
        const buttons = home.filter((b) => b.kind === 'button') as Array<{ text: string; href: string | null }>;
        assert.deepStrictEqual(buttons.map((b) => [b.text, b.href]), [
            ['Discover Our Courses', `${SITE}/our-courses`],
            ['Get in Touch', `${SITE}/contact`],
            ['Read more', `${SITE}/building-relationships`],
            ['Read more', `${SITE}/conferencing-skills`],
            ['hello@restorative.example', 'mailto:hello@restorative.example'],
            ['Read more testimonials', `${SITE}/testimonials`],
            ['Contact us', `${SITE}/contact`],
        ]);
    });

    await check('a link inside a sentence stays part of the sentence (never cut out as a button)', () => {
        assert.ok(pages[0].page.blocks.some((b) => b.kind === 'text' && b.text === 'Read our course notes before you book.'));
        assert.ok(!pages[0].page.blocks.some((b) => b.kind === 'button' && b.text === 'course notes'));
    });

    await check('a paragraph that is only a link is that link ("See all courses")', () => {
        const b = pages[1].page.blocks.find((x) => x.kind === 'button');
        assert.ok(b && b.kind === 'button' && b.text === 'See all courses' && b.href === `${SITE}/our-courses`);
    });

    await check('menus are still never read as content', () => {
        assert.ok(!pages[0].page.blocks.some((b) => 'text' in b && b.text === 'Our Courses' && b.kind === 'button'));
    });

    console.log('\nThe plan and the draft');

    await check('the prompt offers a card button, a second hero button and a call-to-action, and asks that buttons get a place', () => {
        const p = buildImportPrompt(pages, blocks, { siteName: 'R', pictures: 'skip', allowed: () => true });
        assert.ok(p.user.includes('"button2":n|null'));
        assert.ok(p.user.includes('"items":[{"title":n,"body":[n],"button":n|null}]'));
        assert.ok(p.user.includes('{"type":"cta","heading":n,"body":[n],"button":n}'));
        assert.ok(p.user.includes('give every button block that is the business\'s own a place'));
    });

    await check('the plan reader keeps button2, card buttons and cta sections', () => {
        const r = readImportPlan({ pages: [{ page: 1, sections: [
            { type: 'hero', headline: 1, button: 3, button2: 4 },
            { type: 'features', items: [{ title: 6, body: [7], button: 8 }] },
            { type: 'cta', heading: 20, body: [21], button: 22 },
        ] }] })!;
        const [hero, feat, cta] = r.pages[0].sections;
        assert.ok(hero.type === 'hero' && hero.button2 === 4);
        assert.ok(feat.type === 'features' && feat.items[0].button === 8);
        assert.deepStrictEqual(cta, { type: 'cta', heading: 20, body: [21], button: 22 });
    });

    const plan = readImportPlan({ pages: [
        { page: 1, sections: [
            { type: 'hero', headline: n('Restorative practice training for schools'), subheadline: n('Practical courses that help staff build relationships.'), button: n('Discover Our Courses'), button2: n('Get in Touch') },
            { type: 'features', heading: n('Our courses'), items: [
                { title: n('Building Relationships'), body: [n('A working-with approach for every professional.')], button: blocks.find((b) => b.block.kind === 'button' && b.block.text === 'Read more')!.n },
                { title: n('Conferencing Skills'), body: [n('Facilitate restorative meetings with confidence.')], button: blocks.filter((b) => b.block.kind === 'button' && b.block.text === 'Read more')[1].n },
            ] },
            { type: 'text', heading: null, body: [n('Read our course notes before you book.')] },
            { type: 'cta', heading: n('Ready to book?'), body: [n('Places fill up each term.')], button: n('Contact us') },
        ] },
        { page: 2, sections: [{ type: 'hero', headline: n('Building Relationships', 1), subheadline: n('A one-day course on working with people, not doing to them.'), button: n('See all courses') }] },
        { page: 3, sections: [{ type: 'contact', heading: n('Contact us'), intro: n('We reply within two working days.') }] },
    ], skip: [] })!;
    const built = assembleImport({ current: current(), pages, blocks, plan, assets: new Map(), maxPages: 5 });
    const def = built.definition;
    const home = def.pages[0].sections;

    await check('the hero keeps its buttons that lead somewhere; one to a page not imported is listed', () => {
        const hero = home[0];
        assert.ok(hero.type === 'hero');
        // "Discover Our Courses" goes to /our-courses, which was not imported: "Get in Touch" becomes the main button.
        assert.deepStrictEqual(hero.props.primaryCta, { label: 'Get in Touch', href: '/contact' });
        assert.strictEqual(hero.props.secondaryCta, null);
        assert.ok(built.notCarried.some((x) => x.startsWith('Button "Discover Our Courses" (linked to /our-courses)')), built.notCarried.join(' | '));
    });

    await check('a hero with two buttons to imported pages keeps both, main then second', () => {
        const hero = def.pages[1].sections[0];
        assert.ok(hero.type === 'hero' && hero.props.headline === 'Building Relationships' && hero.props.primaryCta === null, '"See all courses" → /our-courses, not imported');
        const two = readImportPlan({ pages: [{ page: 1, sections: [{ type: 'hero', headline: n('Restorative practice training for schools'), button: n('Get in Touch'), button2: n('Contact us') }] }], skip: [] })!;
        const h = assembleImport({ current: current(), pages, blocks, plan: two, assets: new Map(), maxPages: 5 }).definition.pages[0].sections[0];
        assert.ok(h.type === 'hero');
        assert.deepStrictEqual([h.props.primaryCta, h.props.secondaryCta], [{ label: 'Get in Touch', href: '/contact' }, { label: 'Contact us', href: '/contact' }]);
    });

    await check('a card keeps its "Read more" link to the page about it; one to a page not imported is listed instead', () => {
        const f = home.find((s) => s.type === 'features');
        assert.ok(f && f.type === 'features');
        assert.deepStrictEqual(f.props.items[0].link, { label: 'Read more', href: '/building-relationships' });
        assert.strictEqual(f.props.items[1].link, undefined, '/conferencing-skills was not imported');
        assert.ok(built.notCarried.some((x) => x.includes('"Read more" (linked to /conferencing-skills)')), built.notCarried.join(' | '));
    });

    await check('a call-to-action band keeps its heading, line and button', () => {
        const c = home.find((s) => s.type === 'cta');
        assert.ok(c && c.type === 'cta');
        assert.deepStrictEqual(c.props, { heading: 'Ready to book?', body: 'Places fill up each term.', button: { label: 'Contact us', href: '/contact' } });
    });

    await check('a leftover button is listed, never dropped quietly; one that is really words (an email) stays as words', () => {
        assert.ok(built.notCarried.some((x) => x.startsWith('Button "Read more testimonials" (linked to /testimonials)')), built.notCarried.join(' | '));
        assert.ok(built.notCarried.some((x) => x.startsWith('Button "Get in Touch" (linked to /contact)')) === false, 'Get in Touch leads to an imported page');
        assert.ok(JSON.stringify(def.pages).includes('hello@restorative.example'));
    });

    await check('every word on the draft, link labels included, is from their site', () => {
        assert.deepStrictEqual(draftWordsAllFromSource(def, pages), []);
    });

    await check('the draft passes the one gate unchanged', () => {
        assert.deepStrictEqual(normaliseSiteDefinition(def, { maxPages: 5 }).definition, def);
    });

    console.log('\nCard links on the site');

    const withCard = (link: unknown): SiteDefinition => {
        const d = structuredClone(def);
        const f = d.pages[0].sections.find((s) => s.type === 'features')!;
        (f.props as { items: Array<Record<string, unknown>> }).items[0].link = link;
        return normaliseSiteDefinition(d, { maxPages: 5 }).definition;
    };
    const cardOf = (d: SiteDefinition) => (d.pages[0].sections.find((s) => s.type === 'features')!.props as { items: Array<{ link?: unknown }> }).items[0];

    await check('the gate: a card link to a page that does not exist, or an unsafe address, is taken off — the card stays', () => {
        assert.strictEqual(cardOf(withCard({ label: 'Read more', href: '/nowhere' })).link, undefined);
        assert.strictEqual(cardOf(withCard({ label: 'Read more', href: 'javascript:alert(1)' })).link, undefined);
        assert.strictEqual(cardOf(withCard({ label: '', href: '/contact' })).link, undefined);
        assert.deepStrictEqual(cardOf(withCard({ label: 'Book', href: 'https://book.example/x' })).link, { label: 'Book', href: 'https://book.example/x' });
    });

    await check('the page draws the card link under its words, escaped', () => {
        const d = withCard({ label: 'Read <more>', href: '/building-relationships' });
        const r = renderSitePage(d, '/', { preview: false, reportUrl: '/report', creditUrl: null } as never);
        assert.ok(r.html.includes('<a class="more" href="/building-relationships">Read &lt;more&gt;</a></div>'), 'link inside the card, after its text');
    });

    await check('splitting into one page keeps card links working: a link to a page that moves becomes a jump down the page', () => {
        const r = applySiteOperation(def, { op: 'combine_pages' }, { maxPages: 5 });
        assert.ok(r.ok, (r as { error?: string }).error);
        const f = (r as { definition: SiteDefinition }).definition.pages[0].sections.find((s) => s.type === 'features')!;
        const link = (f.props as { items: Array<{ link?: { href: string } }> }).items[0].link;
        assert.ok(link && link.href.startsWith('#'), JSON.stringify(link));
    });

    console.log('\nThe editor and the chat');

    await check('the editor offers a link on each feature and step card, and reads it back', () => {
        const js = read('src/components/assistant-site-editor.js');
        assert.ok(js.includes("['link', 'link', 'Link (optional) — e.g. Read more']"));
        assert.ok(js.includes("['link', 'link', 'Link (optional)']"));
        assert.ok(js.includes('data-item-link="label"') && js.includes('data-item-link="href"'));
        assert.ok(js.includes("o.link = label || href ? { label, href } : null"));
    });

    await check('the chat and the first-draft writer know a card can carry a link', () => {
        assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('items:[{title, body, link:{label,href}|null'));
        assert.ok(read('src/utils/site-draft.ts').includes('"items": [ { "title", "body", "link": { "label", "href" } or null } ]'));
    });

    console.log(`\n${passed}/${total} passed`);
}
void main();
