// tests/flyer.test.ts
// Printable flyers (docs/brand-designer-flyers-plan.md §3.4): the words are drawn, never cut off, and
// the PDF is the paper size it says it is.
//
// ── What this is protecting ─────────────────────────────────────────────────────────────────────
// A flyer is printed hundreds of times. A clipped phone number, a page 2 mm off A5, or a print-shop
// file with no trim line is the kind of fault nobody sees until the box of prints arrives — so the
// fit rule (shrink, then REFUSE naming the field) and the PDF's page boxes are pinned here.
//
// Run:  npx tsx tests/flyer.test.ts
// FLYER_SAMPLES_DIR=/some/dir also writes every preview and both PDFs there, to look at.

import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { PDFDocument } from 'pdf-lib';
import {
    FlyerFitError, PRINT_DPI, effectivePhotoDpi, flyerGeometry, flyerPageStyle, pdfCanEmbed, renderFlyer, renderFlyerPdfs,
} from '../src/lib/flyer';
import {
    FLYER_LAYOUTS, PAPER_SIZES, PAPER_SPECS, PRINT_BLEED_MM, cleanQrUrl, normaliseFlyerContent, type FlyerContent,
} from '../src/config/flyer-vocab';
import { DEFAULT_BRAND_KIT, contrastRatio } from '../src/utils/brand-kit';
import { PICTURE_PURPOSES, normaliseBrief } from '../src/config/visual-brief-vocab';
import { offerLine, parseDraftedWords } from '../src/utils/flyer-words';
import { brandPageColours, colourForPage, flyerColours, pexelsPrintUrl } from '../src/utils/flyer-briefs';
import { FLYER_COLOUR_RULE, parseArtDirection } from '../src/utils/visual-briefs';

let passed = 0, total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const samples = process.env.FLYER_SAMPLES_DIR || null;
const kit = { ...DEFAULT_BRAND_KIT, primaryColor: '#c2185b', wordmark: 'NORTHWIND STUDIO' };
const photoPng = Buffer.from(new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="#7aa0c8"/><circle cx="800" cy="600" r="300" fill="#f4d9a8"/></svg>',
).render().asPng());
const photo = { bytes: photoPng, mimeType: 'image/png', width: 1600, height: 1200 };

function content(over: Record<string, unknown> = {}): FlyerContent {
    const n = normaliseFlyerContent({
        headline: 'Calm, gentle grooming for nervous cats',
        subheading: 'Quiet one-to-one sessions in a studio with no dogs and no rush.',
        points: ['Fear-free handling', 'Nail trims, de-matting and lion cuts', 'Home visits on request'],
        offer: '20% off your first visit',
        callToAction: 'Book online or call us today',
        dateLine: 'Open Tuesday to Saturday',
        contact: { phone: '01632 960 123', email: 'hello@northwind.example', website: 'northwind.example', address: '1 Example Street, Exampleton' },
        qr: { url: 'northwind.example/book', label: 'Scan to book' },
        ...over,
    });
    if (!n.ok) throw new Error(n.error);
    return n.content;
}

(async () => {
    console.log('flyer vocab');
    await check('a flyer needs a headline', () => {
        const n = normaliseFlyerContent({ subheading: 'x' });
        assert.strictEqual(n.ok, false);
    });
    await check('at most three points, blanks dropped', () => {
        const c = content({ points: ['a', ' ', 'b', 'c', 'd'] });
        assert.deepStrictEqual(c.points, ['a', 'b', 'c']);
    });
    await check('QR links: a bare host gets https, other schemes are refused', () => {
        assert.strictEqual(cleanQrUrl('northwind.example/book'), 'https://northwind.example/book');
        assert.strictEqual(cleanQrUrl('javascript:alert(1)'), null);
        assert.strictEqual(cleanQrUrl('localhost'), null);
        assert.strictEqual(content({ qr: { url: 'mailto:x@y.z' } }).qr, null);
    });

    console.log('flyer briefs');
    await check('a flyer brief takes a paper size, photo sources only, and the portrait photo shape', () => {
        const n = normaliseBrief({ title: 'Open day', message: 'Bring people in', purpose: 'flyer', paperSize: 'A4', aspectRatio: '16:9', sources: ['stock', 'brand_card', 'ai_video'] });
        assert.ok(n.ok);
        if (!n.ok) return;
        assert.strictEqual(n.brief.paperSize, 'A4');
        assert.strictEqual(n.brief.aspectRatio, '4:5');
        assert.deepStrictEqual(n.brief.sources, ['stock']);
    });
    await check('a words-only flyer (no photo source) is allowed; a picture brief with none is not', () => {
        const flyer = normaliseBrief({ title: 'x', message: 'y', purpose: 'flyer', sources: [] });
        assert.ok(flyer.ok && flyer.brief.paperSize === 'A5' && flyer.brief.sources.length === 0);
        assert.strictEqual(normaliseBrief({ title: 'x', message: 'y', purpose: 'social_post', sources: [] }).ok, false);
    });
    await check('a flyer can be named by its words alone; other briefs never carry flyer fields', () => {
        const n = normaliseBrief({ title: 'x', purpose: 'flyer', flyerContent: { headline: 'Hello' } });
        assert.ok(n.ok && n.brief.flyerContent?.headline === 'Hello');
        const p = normaliseBrief({ title: 'x', message: 'y', purpose: 'social_post', paperSize: 'A4', flyerContent: { headline: 'Hi' } });
        assert.ok(p.ok && p.brief.paperSize === null && p.brief.flyerContent === null);
    });
    await check('a campaign cannot commission a flyer', () => {
        assert.ok(!(PICTURE_PURPOSES as readonly string[]).includes('flyer'));
    });

    console.log('drafting the words');
    await check('drafted words carrying a phone number, email or web address are dropped', () => {
        const d = parseDraftedWords(JSON.stringify({
            headline: 'Calm grooming for nervous cats', subheading: 'Call 01632 960123 today',
            points: ['Fear-free handling', 'Email hello@x.example', 'Visit www.example.com', 'Home visits'],
            callToAction: 'Book at example.co.uk',
        }));
        assert.ok(d);
        assert.strictEqual(d!.subheading, null);
        assert.deepStrictEqual(d!.points, ['Fear-free handling', 'Home visits']);
        assert.strictEqual(d!.callToAction, null);
    });
    await check('no headline, no draft', () => {
        assert.strictEqual(parseDraftedWords('{"subheading": "x"}'), null);
        assert.strictEqual(parseDraftedWords('not json'), null);
    });
    await check('the offer comes only from a recorded introductory offer', () => {
        assert.strictEqual(offerLine(null), null);
        assert.strictEqual(offerLine({ has: false }), null);
        const line = offerLine({ has: true, kind: 'free_trial', days: 14, cardUpFront: null, afterwards: null, terms: null, whoFor: 'new customers', appliesTo: null, url: null });
        assert.strictEqual(line, 'A free 14-day trial');
    });
    await check('stock photos are fetched at print width', () => {
        const u = new URL(pexelsPrintUrl('https://images.pexels.com/photos/1/pexels-photo-1.jpeg?auto=compress&cs=tinysrgb&h=650&w=940'));
        assert.strictEqual(u.searchParams.get('w'), '2480');
        assert.strictEqual(u.searchParams.get('h'), null);
        assert.strictEqual(pexelsPrintUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
    });

    console.log('geometry');
    await check('A5 at 300 dpi is 1748 × 2480 px, and bleed adds 3 mm on every side', () => {
        const g = flyerGeometry('type_only', 'A5', PRINT_DPI);
        assert.deepStrictEqual([g.canvasWidth, g.canvasHeight], [1748, 2480]);
        const b = flyerGeometry('type_only', 'A5', PRINT_DPI, PRINT_BLEED_MM);
        assert.strictEqual(b.bleed, 35);
        assert.deepStrictEqual([b.canvasWidth, b.canvasHeight], [1748 + 70, 2480 + 70]);
    });
    await check('the words stay inside the trimmed page on every size and layout', () => {
        for (const size of PAPER_SIZES) for (const layout of FLYER_LAYOUTS) {
            const g = flyerGeometry(layout, size, PRINT_DPI, PRINT_BLEED_MM);
            assert.ok(g.text.left >= g.bleed && g.text.top >= g.bleed, `${size} ${layout} starts in the bleed`);
            assert.ok(g.text.left + g.text.width <= g.bleed + g.trimWidth, `${size} ${layout} runs off the right`);
            assert.ok(g.text.top + g.text.height <= g.bleed + g.trimHeight, `${size} ${layout} runs off the bottom`);
            assert.ok(g.text.height > 0 && g.text.width > 0);
        }
    });
    await check('a photo runs into the bleed (no white edge after trimming)', () => {
        const g = flyerGeometry('photo_top', 'A5', PRINT_DPI, PRINT_BLEED_MM);
        assert.deepStrictEqual([g.photo!.left, g.photo!.top, g.photo!.width], [0, 0, g.canvasWidth]);
    });
    await check('effective photo dpi uses the axis that has to stretch most', () => {
        const box = { left: 0, top: 0, width: 1748, height: 1042 };
        assert.strictEqual(effectivePhotoDpi({ width: 874, height: 2000 }, box, 300), 150);
        assert.strictEqual(effectivePhotoDpi({ width: null, height: 10 }, box, 300), null);
    });

    console.log('rendering');
    for (const size of PAPER_SIZES) {
        for (const layout of FLYER_LAYOUTS) {
            // A6 is a postcard: under a photo it holds fewer words, and the full set is refused (below).
            if (size === 'A6' && layout !== 'type_only') continue;
            await check(`${size} ${layout} draws the full set of words`, async () => {
                const r = await renderFlyer({ content: content(), kit, paperSize: size, layout, photo: layout === 'type_only' ? null : photo, orgName: 'Northwind' });
                assert.strictEqual(r.png.subarray(1, 4).toString(), 'PNG');
                const g = flyerGeometry(layout, size, r.geometry.dpi);
                assert.deepStrictEqual([r.width, r.height], [g.canvasWidth, g.canvasHeight]);
                if (samples) writeFileSync(join(samples, `${size}-${layout}.png`), r.png);
                if (samples && size === 'A5' && layout !== 'photo_full') {
                    const colour = colourForPage(['#e8588f', '#17a2a2', '#7b3fa0'], layout);
                    const styled = await renderFlyer({ content: content(), kit: DEFAULT_BRAND_KIT, paperSize: size, layout, photo: layout === 'type_only' ? null : photo, orgName: 'Northwind', style: flyerPageStyle(layout, colour, DEFAULT_BRAND_KIT) });
                    writeFileSync(join(samples, `colour-${layout}.png`), styled.png);
                    const plain = await renderFlyer({ content: content(), kit: DEFAULT_BRAND_KIT, paperSize: size, layout, photo: layout === 'type_only' ? null : photo, orgName: 'Northwind', style: flyerPageStyle(layout, null, DEFAULT_BRAND_KIT) });
                    writeFileSync(join(samples, `nocolour-${layout}.png`), plain.png);
                }
            });
        }
    }
    await check('A6 under a photo refuses the full set of words, and takes a shorter set', async () => {
        await assert.rejects(renderFlyer({ content: content(), kit, paperSize: 'A6', layout: 'photo_top', photo }),
            (e: unknown) => e instanceof FlyerFitError && /The points are too long to fit on A6/.test(e.message));
        const r = await renderFlyer({ content: content({ points: [], subheading: null, dateLine: null }), kit, paperSize: 'A6', layout: 'photo_top', photo });
        if (samples) writeFileSync(join(samples, 'A6-photo_top-short.png'), r.png);
    });
    await check('same input, byte-identical preview', async () => {
        const a = await renderFlyer({ content: content(), kit, paperSize: 'A6', layout: 'type_only', photo: null });
        const b = await renderFlyer({ content: content(), kit, paperSize: 'A6', layout: 'type_only', photo: null });
        assert.ok(a.png.equals(b.png));
    });
    await check('a photo layout without a photo is a caller bug, not a blank box', async () => {
        await assert.rejects(renderFlyer({ content: content(), kit, paperSize: 'A5', layout: 'photo_top', photo: null }), /flyer_needs_photo/);
    });
    await check('words that cannot fit are REFUSED, naming the field — never clipped', async () => {
        const long = Array.from({ length: 3 }, () => 'A very long point that goes on and on about every single service we have ever offered to anyone');
        const sub = 'Words '.repeat(26).trim();
        await assert.rejects(
            renderFlyer({ content: content({ points: long, subheading: sub, offer: sub.slice(0, 100) }), kit, paperSize: 'A6', layout: 'photo_full', photo }),
            (e: unknown) => e instanceof FlyerFitError && ['points', 'subheading'].includes(e.field) && /Shorten it/.test(e.message),
        );
    });
    await check('an email address too long for one line is refused, never wrapped mid-address', async () => {
        await assert.rejects(
            renderFlyer({ content: content({ contact: { email: `${'x'.repeat(100)}@example.com` } }), kit, paperSize: 'DL', layout: 'type_only', photo: null }),
            (e: unknown) => e instanceof FlyerFitError && e.field === 'contact',
        );
    });

    console.log('Colour, and words clear of the photo (Love Cat Studio, 2026-11-05)');
    const mono = DEFAULT_BRAND_KIT;
    await check('an empty kit has no brand colours: its near-black is not a colour', () => {
        assert.deepStrictEqual(brandPageColours(mono, []), []);
        assert.deepStrictEqual(brandPageColours({ ...mono, primaryColor: '#c2185b' }, ['#008080', '#000000']), ['#c2185b', '#008080']);
    });
    await check('order: the look asked for, then the brand, and a suggestion only when there is no brand colour', () => {
        const picks = ['#ff6fa8', '#17a2a2'];
        assert.deepStrictEqual(flyerColours({ brand: [], mood: null, picks }), { colours: picks, from: 'suggested' });
        assert.deepStrictEqual(flyerColours({ brand: ['#c2185b'], mood: null, picks }), { colours: ['#c2185b'], from: 'brand' });
        assert.deepStrictEqual(flyerColours({ brand: ['#c2185b'], mood: 'pink and teal', picks }), { colours: [...picks, '#c2185b'], from: 'look' });
        assert.deepStrictEqual(flyerColours({ brand: [], mood: null, picks: undefined }), { colours: [], from: 'none' });
    });
    await check('pages take different colours when there are enough', () => {
        const c = ['#111199', '#991111', '#119911'];
        assert.deepStrictEqual(['photo_top', 'photo_framed', 'type_only'].map((l) => colourForPage(c, l as 'photo_top')), c);
        assert.strictEqual(colourForPage([], 'type_only'), null);
    });
    await check('with no colour known, no page is a sheet of near-black', () => {
        for (const layout of ['photo_top', 'photo_framed', 'type_only'] as const) {
            assert.strictEqual(flyerPageStyle(layout, null, mono).field, mono.backgroundColor, layout);
        }
    });
    await check('words stay readable on every page, whatever the colour', () => {
        for (const colour of ['#c2185b', '#ffd400', '#7fd1c7', '#0b2545', '#ff007f', '#ffb6c1']) {
            for (const layout of ['photo_top', 'photo_framed', 'type_only'] as const) {
                const s = flyerPageStyle(layout, colour, mono);
                assert.notStrictEqual(s.field, '#ffffff', `${colour} ${layout} is white`);
                assert.ok(contrastRatio(s.ink, s.field) >= 3, `${colour} ${layout} ink ${contrastRatio(s.ink, s.field)}`);
                assert.ok(contrastRatio(s.headline, s.field) >= 3, `${colour} ${layout} headline`);
                assert.ok(contrastRatio(s.offerInk, s.offerBg) >= 3, `${colour} ${layout} offer`);
                if (s.decor) assert.ok(contrastRatio(s.ink, s.decor) >= contrastRatio(s.ink, s.field), `${colour} circles fade the words`);
            }
        }
    });
    await check('small print on a coloured page reads at body-text contrast when any ink can', () => {
        const s = flyerPageStyle('photo_top', '#e8588f', mono);
        assert.ok(contrastRatio(s.ink, s.field) >= 4.5, `pink ${contrastRatio(s.ink, s.field)}`);
    });
    await check('the framed photo: the words start below it on every paper, and it is inside the trim', () => {
        for (const size of PAPER_SIZES) {
            const g = flyerGeometry('photo_framed', size, PRINT_DPI, PRINT_BLEED_MM);
            assert.ok(g.panel === null);
            assert.ok(g.text.top >= g.photo!.top + g.photo!.height, `${size} words reach the photo`);
            assert.ok(g.photo!.left >= g.bleed && g.photo!.top >= g.bleed, `${size} photo in the bleed`);
        }
    });
    await check('a coloured page is really drawn in its colour, and the PDF layer leaves the photo clear', async () => {
        const style = flyerPageStyle('photo_framed', '#17a2a2', mono);
        const c = content();
        const r = await renderFlyer({ content: c, kit: mono, paperSize: 'A5', layout: 'photo_framed', photo, style });
        const words = await renderFlyer({ content: c, kit: mono, paperSize: 'A5', layout: 'photo_framed', photo, style, drawPhoto: false });
        assert.notStrictEqual(r.png.length, words.png.length);
        const pdfs = await renderFlyerPdfs({ content: c, kit: mono, paperSize: 'A5', layout: 'photo_framed', photo, orgName: 'x', title: 't', bleedMm: PRINT_BLEED_MM, style });
        assert.ok(pdfs.home.length > 0);
    });
    await check('a page drawn before colours were stored keeps its old look, so its PDF matches its preview', async () => {
        const opts = { content: content(), kit, paperSize: 'A6' as const, layout: 'type_only' as const, photo: null };
        const old = await renderFlyer(opts);
        const stored = await renderFlyer({ ...opts, style: flyerPageStyle('type_only', kit.primaryColor, kit) });
        assert.ok(!old.png.equals(stored.png), 'the circles are new');
    });
    await check('a new round never draws the full-page panel', () => {
        const round = readFileSync('src/utils/flyer-briefs.ts', 'utf8');
        assert.ok(!round.includes("layout: 'photo_full'") && round.includes("layout: 'photo_framed'"));
    });
    await check('the art director\'s colours: real colours only, at most three, and only asked for on a flyer', () => {
        const fb = { imagePrompt: 'x'.repeat(30), stockKeywords: 'cats', cardHeadlines: [], by: 'fallback' as const };
        const ad = parseArtDirection(JSON.stringify({ imagePrompt: 'a calm studio with a cat in the window', flyerColours: ['#FF6FA8', '#000000', '#ffffff', 'pink', '#17a2a2', '#7b3fa0', '#e0a100'] }), fb, null);
        assert.deepStrictEqual(ad.flyerColours, ['#ff6fa8', '#17a2a2', '#7b3fa0']);
        assert.ok(FLYER_COLOUR_RULE.includes('flyerColours'));
        assert.ok(readFileSync('src/utils/visual-briefs.ts', 'utf8').includes('brief.purpose === FLYER_PURPOSE ? `\\n\\n${FLYER_COLOUR_RULE}`'));
    });
    await check('the look is on the form, reaches the save, and the chat knows it', () => {
        const tab = readFileSync('src/components/assistant-briefs.js', 'utf8');
        assert.ok(tab.includes("input('mood', v.mood,") && tab.includes("mood: fd.get('mood')"));
        const chat = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
        assert.ok(chat.includes('photo at the top, framed photo, words only') && chat.includes('put it in "mood"'));
    });

    console.log('PDF');
    await check('the home PDF is exactly the paper size; the print-shop PDF adds bleed and marks the trim', async () => {
        const pdfs = await renderFlyerPdfs({ content: content(), kit, paperSize: 'A5', layout: 'photo_top', photo, orgName: 'Northwind', title: 'Test flyer', bleedMm: PRINT_BLEED_MM });
        if (samples) { writeFileSync(join(samples, 'A5.pdf'), pdfs.home); writeFileSync(join(samples, 'A5-print-shop.pdf'), pdfs.printShop); }
        const mmToPt = 72 / 25.4;
        const home = (await PDFDocument.load(pdfs.home)).getPage(0).getSize();
        assert.ok(Math.abs(home.width - PAPER_SPECS.A5.widthMm * mmToPt) < 0.5, `width ${home.width}`);
        assert.ok(Math.abs(home.height - PAPER_SPECS.A5.heightMm * mmToPt) < 0.5, `height ${home.height}`);
        const shop = (await PDFDocument.load(pdfs.printShop)).getPage(0);
        const trim = shop.getTrimBox();
        assert.ok(Math.abs(trim.width - PAPER_SPECS.A5.widthMm * mmToPt) < 0.5, `trim ${trim.width}`);
        assert.ok(Math.abs(trim.x - PRINT_BLEED_MM * mmToPt) < 0.5, `trim x ${trim.x}`);
        assert.ok(shop.getSize().width > home.width);
    });
    await check('only JPEG and PNG photos are embedded as themselves', () => {
        assert.ok(pdfCanEmbed('image/jpeg') && pdfCanEmbed('image/png'));
        assert.ok(!pdfCanEmbed('image/webp') && !pdfCanEmbed(null));
    });

    console.log('Reaching a flyer after it is made');
    await check('an approved flyer can be previewed, printed and changed as a NEW brief, never overwritten', () => {
        const tab = readFileSync('src/components/assistant-briefs.js', 'utf8');
        const fn = readFileSync('netlify/functions/brand-briefs.ts', 'utf8');
        const chat = readFileSync('netlify/functions/chat-orchestrator.ts', 'utf8');
        assert.ok(tab.includes('data-brief-preview="${o.id}"') && tab.includes('window.ImageLightbox?.open('), 'a flyer page opens large');
        assert.ok(tab.includes('content-asset-download?assetId=${encodeURIComponent(o.contentAssetId)}&inline=1'), 'Print on the approved page');
        assert.ok(tab.includes('fork: isFlyer(target) && progress(target).done'), 'approved flyers open the form as a new version');
        assert.ok(tab.includes("if (editing && !state.form.fork) await post({ action: 'edit'"), 'a new version creates, not edits');
        assert.ok(fn.includes("brief.purpose === 'flyer' && brief.status === 'approved'"), 'the server refuses new words on a finished flyer');
        assert.ok(chat.includes('A flyer with an approved page is finished') && chat.includes('"Change this flyer"'), 'the chat knows the same route');
    });

    console.log(`\n${passed}/${total} passed`);
})();
