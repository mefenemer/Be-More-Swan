// tests/site-gallery.test.ts
// The gallery section: the owner's own pictures (library assets or https), each described (alt,
// required) with an optional caption, as even squares or at their own shape, each linking to itself
// full size. Library pictures pass the same ownership check as every other picture (assetIdsIn).
//
// Run:  npx tsx tests/site-gallery.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetIdsIn, LIMITS, normaliseSiteDefinition, withoutAssets, type GalleryProps, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { siteFromDraftReply } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const gate = (props: Record<string, unknown>, look?: Record<string, unknown>) => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Florist' },
    pages: [{ title: 'Home', slug: '', sections: [{ id: 'g1', type: 'gallery', props, ...(look ? { look } : {}) }] }],
});
const galleryOf = (d: SiteDefinition) => d.pages[0].sections.find((s) => s.type === 'gallery')?.props as GalleryProps | undefined;
const live = { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, assetUrl: (id: number) => `https://media.example/a/${id}` };

console.log('\nThe gate');

check('keeps described pictures with captions; square by default', () => {
    const g = galleryOf(gate({ heading: 'Our work', images: [
        { assetId: 11, alt: 'Bridal bouquet of white peonies', caption: 'June wedding, Harrogate' },
        { url: 'https://cdn.example/shop.jpg', alt: 'The shop front' },
    ] }).definition)!;
    assert.strictEqual(g.layout, 'square');
    assert.deepStrictEqual(g.images, [
        { url: '', alt: 'Bridal bouquet of white peonies', assetId: 11, caption: 'June wedding, Harrogate' },
        { url: 'https://cdn.example/shop.jpg', alt: 'The shop front', caption: null },
    ]);
});
check('a picture without a description, or on http, is left out with the reason', () => {
    const r = gate({ images: [{ assetId: 11, alt: '' }, { url: 'http://x.example/a.jpg', alt: 'A' }, { assetId: 12, alt: 'Tulips' }] });
    assert.deepStrictEqual(galleryOf(r.definition)!.images.map((i) => i.assetId), [12]);
    assert.ok(r.warnings.some((w) => /short description/.test(w)));
    assert.ok(r.warnings.some((w) => /https/.test(w)));
});
check('no usable pictures → no gallery, in words', () => {
    const r = gate({ images: [] });
    assert.strictEqual(galleryOf(r.definition), undefined);
    assert.ok(r.warnings.some((w) => /gallery was left out/.test(w)));
});
check('up to 24 pictures', () => {
    const many = Array.from({ length: LIMITS.galleryImages + 3 }, (_, i) => ({ assetId: i + 1, alt: `Picture ${i + 1}` }));
    const r = gate({ images: many });
    assert.strictEqual(galleryOf(r.definition)!.images.length, 24);
    assert.ok(r.warnings.some((w) => /up to 24/.test(w)));
});
check('library pictures are checked for ownership like any other; dropping them all drops the gallery', () => {
    const d = gate({ images: [{ assetId: 11, alt: 'A' }, { assetId: 12, alt: 'B' }] }).definition;
    assert.deepStrictEqual(assetIdsIn(d), [11, 12]);
    assert.deepStrictEqual(galleryOf(withoutAssets(d, new Set([11])))!.images.map((i) => i.assetId), [12]);
    assert.strictEqual(galleryOf(withoutAssets(d, new Set([11, 12]))), undefined);
});

console.log('\nOn the page');

check('each picture is a figure linking to itself full size, with its description and caption', () => {
    const html = renderSitePage(gate({ heading: 'Our work', images: [{ assetId: 11, alt: 'Peony bouquet', caption: 'June wedding' }] }).definition, '/', live).html;
    assert.ok(html.includes('<div class="grid gal sq"><figure class="gi"><a href="https://media.example/a/11"><img src="https://media.example/a/11" alt="Peony bouquet" loading="lazy"></a><figcaption>June wedding</figcaption></figure></div>'));
    assert.ok(html.includes('<h2>Our work</h2>') || html.includes('Our work</h'));
});
check('natural layout, and the columns look still applies to the gallery\'s grid', () => {
    const html = renderSitePage(gate({ layout: 'natural', images: [{ assetId: 11, alt: 'A' }, { assetId: 12, alt: 'B' }] }, { columns: 3 }).definition, '/', live).html;
    assert.ok(html.includes('<div class="grid c3 gal nat">'));
});
check('the columns look still works on the other grids', () => {
    const d = normaliseSiteDefinition({ settings: { siteName: 'B' }, pages: [{ title: 'Home', slug: '', sections: [{ id: 'f1', type: 'features', look: { columns: 2 }, props: { items: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }] } }] }] }).definition;
    assert.ok(renderSitePage(d, '/', live).html.includes('class="grid c2"'));
});
check('a gallery with no drawable pictures is absent', () => {
    const html = renderSitePage(gate({ images: [{ assetId: 11, alt: 'A' }] }).definition, '/', { ...live, assetUrl: () => null }).html;
    assert.ok(!html.includes('id="g1"'));
});

console.log('\nDrafts, editor, chat, picker');

check('a whole-site draft never adds a gallery (the pictures are the owner\'s choice)', () => {
    const current = gate({ images: [{ assetId: 11, alt: 'A' }] }).definition;
    const d = siteFromDraftReply({ pages: [{ title: 'Home', slug: '', sections: [
        { type: 'hero', props: { headline: 'Flowers for every day' } },
        { type: 'gallery', props: { images: [{ assetId: 11, alt: 'A' }] } },
    ] }] }, current, 5);
    assert.ok(d && !d.definition.pages.some((p) => p.sections.some((s) => s.type === 'gallery')));
});
check('the editor, the chat and the picture picker know galleries', () => {
    const editor = read('src/components/assistant-site-editor.js');
    assert.ok(editor.includes("gallery: 'Gallery'") && editor.includes("kind: 'gallery'") && editor.includes('multiple: true') && editor.includes('onPickMany'));
    const picker = read('src/components/media-picker.js');
    assert.ok(picker.includes('data-mp-done') && picker.includes("${multiple ? 'multiple' : ''}"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('gallery {heading, intro, layout:"square|natural", images:[{assetId, alt, caption}]}'));
});

console.log(`\n${passed}/${total} passed\n`);
