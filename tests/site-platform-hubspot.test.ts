// tests/site-platform-hubspot.test.ts
// The Website import on HubSpot Content Hub (CMS Hub) sites — src/utils/site-builders/hubspot.ts.
// Synthetic pages modelled on HubSpot's markup (tests/fixtures/site-platforms/hubspot/): a theme page with
// drag-and-drop sections, an older COS template with no <main>, a blog post, and a hand-made site that
// only carries HubSpot's tracking code. No network, no model.
// Findings: docs/site-import-platforms/hubspot.md
//
// Run:  npx tsx tests/site-platform-hubspot.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/hubspot';
import { readImportPage, type ImportBlock } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/hubspot', `${f}.html`), 'utf8');
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (blocks: ImportBlock[]) => blocks.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (blocks: ImportBlock[]) => blocks.filter((b): b is Extract<ImportBlock, { kind: 'image' }> => b.kind === 'image').map((b) => b.src);

const FERN = 'https://www.fernleigh.example';
const BRACK = 'https://www.brackenford.example';

async function main() {
    console.log('\nFinding HubSpot');

    await check('theme pages, older COS templates and blog posts are recognised', () => {
        assert.strictEqual(found(fixture('home')), 'hubspot');
        assert.strictEqual(found(fixture('legacy')), 'hubspot');
        assert.strictEqual(found(fixture('blog-post')), 'hubspot');
        assert.strictEqual(found('<html><body><div class="hs_cos_wrapper hs_cos_wrapper_type_rich_text"><p>x</p></div></body></html>'), 'hubspot');
    });

    await check('HubSpot\'s tracking code or a file on its CDN alone is not a HubSpot site', () => {
        assert.strictEqual(found(fixture('tracking-only')), null);
        assert.strictEqual(readImportPage(fixture('tracking-only'), 'https://hollin.example/').platform, null);
    });

    console.log('\nA theme page (drag-and-drop)');
    const home = readImportPage(fixture('home'), `${FERN}/`);

    await check('their words in order; the hero\'s background picture (kept in a <style> block) comes first', () => {
        assert.strictEqual(home.platform, 'hubspot');
        assert.deepStrictEqual(home.blocks.slice(0, 4).map((b) => b.kind), ['image', 'heading', 'text', 'button']);
        assert.strictEqual(images(home.blocks)[0], `${FERN}/hs-fs/hubfs/Garden%20rooms/oak-room-dusk.jpg?width=1600`);
        assert.ok(texts(home.blocks).includes('Every room signed off by the person who built it'));
        // A colour drawn as a gradient is not a picture.
        assert.strictEqual(images(home.blocks).filter((s) => s.includes('gradient')).length, 0);
    });

    await check('the menu: no language switcher, drop-downs kept, ?hsLang= gone from every link', () => {
        assert.deepStrictEqual(home.navLinks.map((l) => l.text), ['Garden rooms', 'Garden offices', 'Studios', 'About us', 'Blog', 'Contact']);
        assert.strictEqual(home.navLinks.find((l) => l.text === 'Studios')?.group, 'Garden rooms');
        assert.ok(!JSON.stringify(home).includes('hsLang'));
        const inline = home.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Read how we build'));
        assert.deepStrictEqual(inline && 'links' in inline ? inline.links : null, [{ text: 'how we build', href: `${FERN}/how-we-build` }]);
    });

    await check('pictures at full size (largest of the srcset, through HubSpot\'s resizer, no bigger than 1600) — the logo too', () => {
        assert.ok(images(home.blocks).includes(`${FERN}/hs-fs/hubfs/Garden%20rooms/workshop.jpg?width=1600`));
        assert.strictEqual(home.logo?.src, `${FERN}/hs-fs/hubfs/Fernleigh-logo.png?width=1600`);
        assert.strictEqual(home.logo?.alt, 'Fernleigh Garden Rooms');
    });

    await check('an older image CTA becomes the button it shows, not a picture of one', () => {
        const b = home.blocks.find((x) => x.kind === 'button' && x.text === 'Download the brochure');
        assert.ok(b && b.kind === 'button' && b.href?.startsWith('https://cta-redirect.hubspot.com/'));
        assert.ok(!images(home.blocks).some((s) => s.includes('/cta/')));
    });

    await check('the HubSpot form (drawn by script) counts as a form; its title stays; the search box does not count', () => {
        assert.ok(home.hasForm);
        assert.ok(texts(home.blocks).includes('Ask us about your garden'));
        assert.deepStrictEqual(home.formFields, []);
        const noForm = fixture('home').replace(/<div id="hs_form_target_[^>]*><\/div>/, '');
        assert.strictEqual(readImportPage(noForm, `${FERN}/`).hasForm, false);
    });

    await check('cookie bar, chat, "Skip to content" and footer lines are not their words; contact details still read', () => {
        const all = texts(home.blocks).join(' | ');
        for (const t of ['cookies', 'Chat with us', 'Skip to content', 'Accept', 'English', 'Cymraeg', 'All rights reserved']) assert.ok(!all.includes(t), t);
        assert.deepStrictEqual(home.contact.emails, ['hello@fernleigh.example']);
        assert.deepStrictEqual(home.contact.phones, ['01632960123']);
        assert.deepStrictEqual(home.socialLinks, ['https://www.instagram.com/fernleigh.example']);
    });

    await check('the same furniture on a page with no <main> (the chat and cookie bar sit outside the content)', () => {
        const page = readImportPage(fixture('home').replace('<main id="main-content" class="body-container-wrapper">', '<div class="x">').replace('</main>', '</div>'), `${FERN}/`);
        const all = texts(page.blocks).join(' | ');
        assert.ok(!all.includes('Chat with us') && !all.includes('cookies'), all);
        assert.ok(all.includes('Garden rooms built to last a lifetime'));
    });

    console.log('\nAn older COS template');
    const legacy = readImportPage(fixture('legacy'), `${BRACK}/about`);

    await check('the header and footer drawn in <div>s: menu read as the menu, logo as the logo, neither as content', () => {
        assert.deepStrictEqual(legacy.navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Bookkeeping', 'Services'], ['Payroll', 'Services'], ['About', null], ['Contact', null]]);
        assert.strictEqual(legacy.logo?.src, `${BRACK}/hs-fs/hub/9990002/file-1234567890-png/images/brackenford-logo.png?width=1600&t=1500000000000`);
        const all = texts(legacy.blocks);
        assert.strictEqual(all[0], 'About Brackenford');
        assert.ok(!all.some((t) => /Bookkeeping Payroll|4 Mill Lane|©/.test(t)), all.join(' | '));
        assert.deepStrictEqual(legacy.contact.emails, ['office@brackenford.example']);
    });

    await check('pictures on HubSpot\'s file CDN are originals; share buttons are not pictures; the embed-code form counts', () => {
        assert.deepStrictEqual(images(legacy.blocks), ['https://cdn2.hubspot.net/hubfs/9990002/Banners/desk-banner.jpg', 'https://f.hubspotusercontent40.net/hubfs/9990002/Team/team-at-desk.jpg']);
        assert.ok(legacy.hasForm);
        assert.ok(texts(legacy.blocks).includes('Request a call back'));
    });

    console.log('\nA blog post');
    const post = readImportPage(fixture('blog-post'), `${FERN}/blog/how-long`);

    await check('the post\'s own words only: no author line, date, tags, comments or "Read On" posts', () => {
        const all = texts(post.blocks);
        assert.strictEqual(all[0], 'How long does a garden room take to build?');
        for (const t of ['Sam Fernleigh', 'March 2, 2026', 'Building', 'Read On', 'Do I need planning permission?']) assert.ok(!all.includes(t), t);
        assert.deepStrictEqual(images(post.blocks), [`${FERN}/hs-fs/hubfs/Blog/ground-screws.jpg?width=1600`]);
        assert.strictEqual(post.hasForm, false);   // the comment form went with the comments
    });

    console.log('\nPicture addresses');

    await check('fullSizeImage: site host through /hs-fs/ at 1600, CDN originals untouched, others left to the shared rule', () => {
        const f = adapter.fullSizeImage!;
        assert.strictEqual(f(`${FERN}/hubfs/a.jpg`), `${FERN}/hs-fs/hubfs/a.jpg?width=1600`);
        assert.strictEqual(f(`${FERN}/hs-fs/hubfs/a.jpg?width=300&height=200&name=a.jpg`), `${FERN}/hs-fs/hubfs/a.jpg?width=1600`);
        assert.strictEqual(f('https://53.fs1.hubspotusercontent-na1.net/hubfs/53/a.webp?width=300'), 'https://53.fs1.hubspotusercontent-na1.net/hubfs/53/a.webp');
        assert.strictEqual(f(`${FERN}/hubfs/hub_generated/template_assets/1/x.png`), null);
        assert.strictEqual(f(`${FERN}/hubfs/animated.gif`), null);
        assert.strictEqual(f('https://images.example/photo.jpg?w=300'), null);
    });

    console.log('\nThe whole import (no network, no model)');

    await check('runImport reads the home page and its menu pages; the HubSpot form is reported; nothing of HubSpot\'s is on the draft', async () => {
        const pages: Record<string, string> = {
            [`${FERN}/`]: fixture('home'),
            [`${FERN}/about`]: fixture('legacy').replace(/brackenford/gi, 'fernleigh'),
            [`${FERN}/blog`]: fixture('blog-post'),
        };
        const pictures: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(u) {
                const html = pages[u] ?? pages[u.replace(/\/$/, '')];
                return html ? { ok: true, html, finalUrl: u } : { ok: false, message: 'That link returned an error (404).' };
            },
            async plan() { return null; },
            async savePicture(src) { pictures.push(src); return 700 + pictures.length; },
        };
        const current = starterSite({ name: 'Fernleigh Garden Rooms', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${FERN}/`, pictures: 'copy', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'hubspot');
        assert.ok(r.report.hadForm);
        assert.strictEqual(r.report.contact.email, 'hello@fernleigh.example');
        const draft = JSON.stringify(r.definition);
        assert.ok(draft.includes('Garden rooms built to last a lifetime'));
        for (const t of ['hsLang', 'cookies', 'Chat with us', 'Cymraeg', 'no-cache.hubspot.com']) assert.ok(!draft.includes(t), t);
        assert.ok(pictures.every((p) => !/[?&](height|name)=/.test(p)), pictures.join(' '));
    });

    console.log(`\n${passed}/${total} passed`);
}

main();
