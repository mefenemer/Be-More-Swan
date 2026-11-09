// tests/site-platform-duda.test.ts
// The Website import on Duda sites (src/utils/site-builders/duda.ts), against SYNTHETIC pages modelled on
// Duda's classic (dmRespRow) and flex layouts — tests/fixtures/site-platforms/duda/. No network, no model.
//
// Run:  npx tsx tests/site-platform-duda.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { dudaFullSize } from '../src/utils/site-builders/duda';
import { readImportPage, type ImportPage } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/duda', `${name}.html`), 'utf8');
const SITE = 'https://www.hollinforge.example';
const read = (name: string) => readImportPage(fixture(name), `${SITE}/`);
const texts = (p: ImportPage) => p.blocks.map((b) => ('text' in b ? b.text : '')).join(' | ');
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b.src] : []));

async function main() {
    console.log('\nDuda');

    await check('Duda pages are recognised (classic and flex layouts), hand-made pages are not', () => {
        for (const f of ['classic-home', 'flex-home', 'classic-services']) assert.strictEqual(adapterFor(fixture(f), cheerio.load(fixture(f)))?.key, 'duda', f);
        const plain = '<html><body><main><p>dmRespRow is just a word here? no.</p></main></body></html>'.replace('dmRespRow', 'rows');
        assert.strictEqual(adapterFor(plain, cheerio.load(plain))?.key ?? null, null);
    });

    await check('the content is the role="main" box: no phone drawer email, footer, share pop-up or powered-by badge', () => {
        const p = read('classic-home');
        const t = texts(p);
        for (const noise of ['hello@hollinforge.example', 'VISIT', 'Share by', 'Fell Web Studio', '© 2026']) assert.ok(!t.includes(noise), noise);
        assert.strictEqual(p.blocks[1].kind, 'heading');
        assert.strictEqual((p.blocks[1] as { text: string }).text, 'Metal Repairs in Kendal');
    });

    await check('menu with its drop-down, logo, contact and social links are still read from header, drawer and footer', () => {
        const p = read('classic-home');
        assert.deepStrictEqual(p.navLinks.map((l) => l.text), ['Home', 'Services', 'Contact', 'Gate Repairs', 'Trailer Repairs']);
        assert.strictEqual(p.navLinks.find((l) => l.text === 'Gate Repairs')?.group, 'Services');
        assert.strictEqual(p.logo?.src, 'https://lirp.cdn-website.com/a1b2c3d4/dms3rep/multi/opt/hollin-forge-logo-1920w.png');
        assert.ok(p.contact.emails.includes('hello@hollinforge.example'));
        assert.ok(p.socialLinks?.some((s) => s.includes('instagram.com/hollinforge.example')));
        assert.deepStrictEqual(p.formFields, ['Name', 'Email', 'What needs fixing?']);
    });

    await check('template placeholders and hidden form messages are not their words', () => {
        const t = texts(read('classic-home'));
        for (const noise of ['Photo By: John Doe', 'Image Title', 'Image Description', 'Button', 'Thank you for contacting us', 'Oops, there was an error']) assert.ok(!t.includes(noise), noise);
        assert.ok(t.includes('Stair railing, Burneside'), 'a real caption stays');
    });

    await check('a box drawn for phones only is not read as a second copy', () => {
        assert.ok(!texts(read('classic-home')).includes('Gates, railings and trailers repaired across the South Lakes.'));
        assert.ok(!texts(read('flex-home')).includes('Tap to book'));
    });

    await check('pictures come at full size, once each: resized, lazy, gallery and logo copies → the 1920-wide copy', () => {
        const imgs = images(read('classic-home'));
        assert.ok(imgs.includes('https://lirp.cdn-website.com/a1b2c3d4/dms3rep/multi/opt/welding-a-gate-1920w.jpg'));
        assert.strictEqual(imgs.filter((s) => s.includes('railing-after')).length, 1, 'gallery thumbnail and its link are one picture');
        assert.ok(!imgs.some((s) => /transparent_background|-806h|\?jxl/.test(s)), imgs.join(' '));
        assert.strictEqual(dudaFullSize('https://irp.cdn-website.com/x1/dms3rep/multi/opt/Untitled+design-547w.png?jxl&v=jxl'), 'https://lirp.cdn-website.com/x1/dms3rep/multi/opt/Untitled+design-1920w.png');
        assert.strictEqual(dudaFullSize('https://irp.cdn-website.com/x1/dms3rep/multi/photo.jpg'), 'https://lirp.cdn-website.com/x1/dms3rep/multi/opt/photo-1920w.jpg');
        assert.strictEqual(dudaFullSize('https://irp.cdn-website.com/x1/dms3rep/multi/spin.gif?dm-skip-opt=true'), 'https://irp.cdn-website.com/x1/dms3rep/multi/spin.gif');
        assert.strictEqual(dudaFullSize('https://example.com/a.jpg'), null);
    });

    await check('background pictures are read: data-background-image rows and flex boxes styled by id', () => {
        assert.ok(images(read('classic-home')).includes('https://lirp.cdn-website.com/a1b2c3d4/dms3rep/multi/opt/forge-hero-1920w.jpg'));
        const flex = images(read('flex-home'));
        for (const n of ['boiler-hero-1920w.jpg', 'van-on-street-9d0328ca-1920w.jpeg', 'radiator-1920w.jpg']) assert.ok(flex.some((s) => s.endsWith(n)), n);
        assert.ok(!flex.some((s) => s.includes('site_background_education')), 'the template page background is not theirs');
    });

    await check('FAQ and testimonials read as question/answer and quote/name, not run-on list items', () => {
        const p = read('classic-home');
        assert.ok(p.blocks.some((b) => b.kind === 'heading' && b.text === 'Do you come out to farms?'));
        assert.ok(p.blocks.some((b) => b.kind === 'text' && b.text.startsWith('Yes, we bring a mobile welder')));
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('swings like new')));
        assert.ok(!p.blocks.some((b) => b.kind === 'item'));
    });

    await check('links inside sentences, buttons, YouTube and the Duda map are kept', () => {
        const p = read('classic-home');
        const para = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('We repair gates')) as { links?: Array<{ text: string; href: string }> };
        assert.deepStrictEqual(para.links, [{ text: 'our gate repairs', href: `${SITE}/gate-repairs` }]);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Ask for a quote' && b.href === `${SITE}/contact`));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'See us on the map' && b.href?.startsWith('https://www.google.com/maps?q=Unit%204')));
        const f = read('flex-home');
        assert.ok(f.blocks.some((b) => b.kind === 'button' && b.href === 'https://www.youtube.com/watch?v=AbCdEfGhIjk'));
    });

    await check('the whole import runs on a Duda site with no model: pages read, pictures full size, nothing thin', async () => {
        const pages: Record<string, string> = { [`${SITE}/`]: fixture('classic-home'), [`${SITE}/services`]: fixture('classic-services') };
        const saved: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { saved.push(src); return 900 + saved.length; },
        };
        const current = starterSite({ name: 'Hollin Forge', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'duda');
        assert.ok(r.report.pages.some((x) => x.url === `${SITE}/services` && x.read && x.words > 40));
        const json = JSON.stringify(r.definition);
        for (const words of ['Metal Repairs in Kendal', 'What We Mend']) assert.ok(json.includes(words), words);
        for (const noise of ['Photo By: John Doe', 'Thank you for contacting us', 'Share by']) assert.ok(!json.includes(noise), noise);
        assert.ok(saved.every((s) => !/-\d{2,3}[wh]\.|\?jxl/.test(s)), saved.join(' '));
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
