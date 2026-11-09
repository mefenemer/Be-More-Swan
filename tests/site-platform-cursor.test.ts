// tests/site-platform-cursor.test.ts
// Website import of sites an owner built themselves with Cursor (the AI code editor). Cursor is an editor,
// not a host, so its sites carry no trace of it: what matters is the shapes such hand-built sites take.
// SYNTHETIC fixtures (tests/fixtures/site-platforms/cursor/, invented businesses): a static Tailwind page,
// a Next.js App Router page, an Astro build, and a Vite + React SPA (shell + rendered DOM).
//
// This pins TODAY's results — what is read and what is lost. A "KNOWN GAP" check failing means shared
// import code got better: update the check and docs/site-import-platforms/cursor.md together.
// No network, no model: readImportPage on saved pages, runImport with fake deps and plan null.
//
// Run:  npx tsx tests/site-platform-cursor.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { readImportPage, type ImportBlock } from '../src/utils/site-extract';
import { draftWordsAllFromSource, runImport, type ImportDeps } from '../src/utils/site-import';
import { readImportedLook } from '../src/utils/site-import-theme';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { adapter } from '../src/utils/site-builders/cursor';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/cursor', `${n}.html`), 'utf8');
const TW = 'https://fernbrook.example/';
const NEXT = 'https://spokesmith.example/';
const ASTRO = 'https://hollinpike.example/';
const VITE = 'https://quayside.example/';
const texts = (bs: ImportBlock[]) => bs.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (bs: ImportBlock[]) => bs.filter((b): b is Extract<ImportBlock, { kind: 'image' }> => b.kind === 'image');
const buttons = (bs: ImportBlock[]) => bs.filter((b): b is Extract<ImportBlock, { kind: 'button' }> => b.kind === 'button');
const current = () => starterSite({ name: 'Test business', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

function deps(pages: Record<string, string>, rendered: Record<string, string> = {}): ImportDeps & { renderedAsked: string[] } {
    const renderedAsked: string[] = [];
    return {
        renderedAsked,
        async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
        async renderHtml(url) { renderedAsked.push(url); const html = rendered[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'not rendered' }; },
        async plan() { return null; },
        async savePicture() { return null; },
    };
}

async function main() {
    console.log('\nDetection');

    await check('cursor never claims a page: hand-built sites carry no reliable trace of the editor', () => {
        for (const n of ['tailwind-static', 'next-app-router', 'astro', 'vite-shell', 'vite-rendered']) {
            const html = fx(n);
            const $ = cheerio.load(html);
            assert.strictEqual(adapter.detect(html, ($('meta[name="generator"]').attr('content') ?? '').toLowerCase(), $), false, n);
            assert.notStrictEqual(readImportPage(html, VITE).platform, 'cursor', n);
        }
        assert.strictEqual(readImportPage(fx('tailwind-static'), TW).platform, null);
    });

    console.log('\nStatic Tailwind page');
    const tw = readImportPage(fx('tailwind-static'), TW);

    await check('words, headings, cards, list, quote, inline link and the Tailwind bg-[url()] hero picture are read in order', () => {
        assert.strictEqual(tw.blocks[0].kind, 'image');
        assert.ok(images(tw.blocks)[0].src.endsWith('/images/hero-greenhouse.jpg'));
        assert.deepStrictEqual(tw.blocks.filter((b) => b.kind === 'heading').map((b) => (b as { text: string }).text),
            ['Bring the outside in', 'Workshops', 'Terrarium building', 'Kokedama', 'Repotting basics', 'Plant clinic', 'Visit the studio']);
        assert.strictEqual(tw.blocks.filter((b) => b.kind === 'item').length, 3, 'icon <svg>s dropped, list words kept');
        assert.ok(tw.blocks.some((b) => b.kind === 'quote' && b.text.includes('fiddle-leaf fig')));
        assert.ok(tw.blocks.some((b) => b.kind === 'text' && b.links?.[0]?.href === 'https://fernbrook.example/care-guides.html'));
        assert.ok(buttons(tw.blocks).some((b) => b.text === 'See us on the map'), 'Google Maps iframe → map button');
        assert.ok(tw.words >= 150);
    });

    await check('a picture with empty alt is described by the nearest heading BEFORE it (the previous card\'s) — shared quirk', () => {
        const rep = images(tw.blocks).find((i) => i.src.endsWith('repotting.jpg'))!;
        assert.strictEqual(rep.altFromSite, false);
        assert.strictEqual(rep.alt, 'Kokedama');
    });

    await check('contact, logo, socials and siteName come from JSON-LD, og:site_name, the header and the footer', () => {
        assert.strictEqual(tw.siteName, 'Fernbrook Plant Studio');
        assert.ok(tw.logo?.src.endsWith('/images/logo.png'));
        assert.deepStrictEqual(tw.contact.emails, ['hello@fernbrook.example']);
        assert.strictEqual(tw.contact.address, '12 Mill Lane, Otterby, OT1 4ZZ');
        assert.deepStrictEqual(tw.socialLinks, ['https://www.instagram.com/fernbrook.example']);
    });

    await check('KNOWN GAP: one phone number in 0… and +44… form is kept twice', () => {
        assert.deepStrictEqual(tw.contact.phones, ['01632 960 418', '+441632960418']);
    });

    await check('KNOWN GAP: in-page #anchor menu links vanish; only the real page link is in the menu', () => {
        assert.deepStrictEqual(tw.navLinks.map((l) => l.text), ['About']);
    });

    await check('KNOWN GAP: hero call-to-action links to #anchors read as plain text, not buttons', () => {
        assert.ok(tw.blocks.some((b) => b.kind === 'text' && b.text === 'Book a workshop'));
        assert.ok(!buttons(tw.blocks).some((b) => b.text === 'Book a workshop'));
    });

    await check('the look: Tailwind CDN config background and the Google Fonts heading face are read; brand colour is not', () => {
        const look = readImportedLook(fx('tailwind-static'), TW, '');
        assert.strictEqual(look.backgroundColor, '#faf6ee');
        assert.strictEqual(look.headingFont, 'Fraunces');
        assert.strictEqual(look.primaryColor, null, 'KNOWN GAP: bg-clay on the anchor CTA is not read as the brand colour');
    });

    console.log('\nNext.js App Router page');
    const nx = readImportPage(fx('next-app-router'), NEXT);

    await check('server-rendered words are read, including those framer-motion starts at opacity:0', () => {
        assert.ok(texts(nx.blocks).includes('Your bike, running like new'));
        assert.ok(texts(nx.blocks).some((t) => t.startsWith('Spokesmith is a two-person workshop')));
        assert.deepStrictEqual(buttons(nx.blocks).map((b) => [b.text, b.href]), [['Book a service', `${NEXT}book`], ['See what we do →', `${NEXT}services`]]);
        assert.deepStrictEqual(nx.navLinks.map((l) => l.text), ['Spokesmith', 'Services', 'E-bikes', 'About', 'Contact', 'Book a service']);
        assert.ok(nx.words >= 100);
    });

    await check('next/image pictures come at their original address, logo included (shared fix, 2026-11-09)', () => {
        assert.deepStrictEqual(images(nx.blocks).map((i) => i.src), [`${NEXT}images/hero-bike.jpg`, `${NEXT}images/workshop.jpg`]);
        assert.strictEqual(nx.logo?.src, `${NEXT}logo.png`);
    });

    await check('a Suspense section streamed in at the end of <body> is put back in place and read (shared fix, 2026-11-09)', () => {
        assert.ok(texts(nx.blocks).some((t) => /What riders say|old tourer/.test(t)));
    });

    await check('the RSC payload (self.__next_f) is never read as words', () => {
        assert.ok(!texts(nx.blocks).some((t) => /\$Sreact|static\/chunks/.test(t)));
    });

    console.log('\nAstro build');
    const as = readImportPage(fx('astro'), ASTRO);

    await check('words, the <picture> fallback <img>, and a server-rendered island are read', () => {
        assert.ok(texts(as.blocks).includes('Baked before the town wakes up'));
        assert.deepStrictEqual(as.blocks.filter((b) => b.kind === 'item').map((b) => (b as { text: string }).text), ['Tuesday to Saturday, 7am to 3pm', 'Sunday, 8am to 1pm']);
        assert.ok(images(as.blocks)[0].src.endsWith('/_astro/counter.B0x1Yq7N_Kq2Lp.jpg'));
        assert.deepStrictEqual(as.navLinks.map((l) => l.text), ['Our bakes', 'Celebration cakes', 'Find us']);
    });

    await check('astro:assets /_image?href= pictures come at their original address; a client:only island\'s words (props only) are still lost', () => {
        assert.ok(images(as.blocks)[1].src.startsWith(`${ASTRO}_astro/starter`), images(as.blocks)[1].src);
        assert.ok(!texts(as.blocks).some((t) => t.includes('cardamom buns')));
    });

    await check('the look reads :root custom properties from an inline <style>', () => {
        const look = readImportedLook(fx('astro'), ASTRO, '');
        assert.strictEqual(look.primaryColor, '#b4532a');
    });

    console.log('\nVite + React SPA');

    await check('the shell has no words; the rendered DOM reads like any page', () => {
        assert.strictEqual(readImportPage(fx('vite-shell'), VITE).words, 0);
        const r = readImportPage(fx('vite-rendered'), VITE);
        assert.ok(r.words >= 140);
        assert.ok(texts(r.blocks).includes('Calm grooming for nervous dogs'));
        assert.strictEqual(images(r.blocks).length, 2, 'lucide icon <svg>s are not pictures');
        assert.deepStrictEqual(r.navLinks.map((l) => l.text), ['Quayside', 'Gallery']);
    });

    await check('KNOWN GAP: onClick-only buttons and <a href="#…"><button> keep no link; the testimonial <p> is text, not a quote', () => {
        const r = readImportPage(fx('vite-rendered'), VITE);
        assert.deepStrictEqual(buttons(r.blocks).map((b) => [b.text, b.href]), [['Book a groom', null], ['See services', null]]);
        assert.ok(!r.blocks.some((b) => b.kind === 'quote'));
    });

    console.log('\nThe whole import (no network, no model)');

    await check('SPA: the shell is too thin, so headless Chrome is asked; the rendered home page becomes a draft of their own words', async () => {
        const d = deps({ [VITE]: fx('vite-shell'), [`${VITE}gallery`]: fx('vite-shell') }, { [VITE]: fx('vite-rendered') });
        const r = await runImport({ url: VITE, pictures: 'skip', current: current(), maxPages: 5 }, d);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.deepStrictEqual(d.renderedAsked, [VITE, `${VITE}gallery`]);
        assert.deepStrictEqual(r.report.pages.map((p) => [p.title, p.read]), [['Quayside', true], ['Gallery', false]], 'the home page takes the logo link\'s words as its menu label');
        assert.strictEqual(r.report.contact.email, 'woof@quayside.example');
        assert.deepStrictEqual(draftWordsAllFromSource(r.definition, [{ url: VITE, menuLabel: null, page: readImportPage(fx('vite-rendered'), VITE) }]), []);
    });

    await check('SPA without a browser: said plainly, nothing made', async () => {
        const d = deps({ [VITE]: fx('vite-shell') });
        delete (d as Partial<ImportDeps>).renderHtml;
        const r = await runImport({ url: VITE, pictures: 'skip', current: current(), maxPages: 5 }, d);
        assert.ok(!r.ok && /JavaScript/.test(r.message));
    });

    await check('Next.js and static pages import without the browser; their menu pages are tried', async () => {
        const n = deps({ [NEXT]: fx('next-app-router') });
        const rn = await runImport({ url: NEXT, pictures: 'skip', current: current(), maxPages: 5 }, n);
        assert.ok(rn.ok);
        assert.deepStrictEqual(n.renderedAsked, [], 'server-rendered: no headless Chrome');
        if (rn.ok) assert.deepStrictEqual(rn.report.pages.map((p) => p.title), ['Spokesmith', 'Services', 'E-bikes', 'About', 'Contact']);
        if (rn.ok) assert.deepStrictEqual(rn.report.notImported.map((p) => p.title), ['Book a service'], 'the header CTA counts as a menu page');
        const t = deps({ [TW]: fx('tailwind-static') });
        const rt = await runImport({ url: TW, pictures: 'skip', current: current(), maxPages: 5 }, t);
        assert.ok(rt.ok);
        if (rt.ok) {
            assert.deepStrictEqual(rt.report.pages.map((p) => [p.title, p.read]), [['Home', true], ['About', false]]);
            assert.ok(rt.report.prices.some((p) => p.includes('£35')), 'the workshop price is listed for Business Information, not put on the site');
            assert.ok(!JSON.stringify(rt.definition.pages).includes('£35'));
        }
    });

    console.log(`\n${passed}/${total} passed`);
}

main();
