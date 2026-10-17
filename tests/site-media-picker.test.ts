// tests/site-media-picker.test.ts
// Pictures and videos on a website (owner, 2026-10-17): the picker offers what the other assistants
// do — upload, the library, stock found by the assistant, and AI-created pictures and videos — and a
// library video plays in a hero, a text section or a gallery (never a logo, sign-up or product).
//
// Run:  npx tsx tests/site-media-picker.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markVideos, normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { isPexelsMediaUrl } from '../netlify/functions/pexels-search';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const site = normaliseSiteDefinition({
    settings: { siteName: 'Salon' },
    theme: { logoAssetId: 7 },
    pages: [{ title: 'Home', slug: '', sections: [
        { type: 'hero', props: { headline: 'Hi', image: { assetId: 7, alt: 'The salon' } } },
        { type: 'text', props: { body: 'About', image: { assetId: 8, alt: 'A chair', video: true } } },
        { type: 'gallery', props: { images: [{ assetId: 7, alt: 'Walkthrough' }, { assetId: 8, alt: 'Chair' }] } },
    ] }],
}).definition;

console.log('\nVideos on a site');

check('the video flag comes from the asset, never the editor; a logo can\'t be one', () => {
    const { definition: d, removed } = markVideos(site, new Set([7]));
    const [hero, text, gallery] = d.pages[0].sections as any[];
    assert.strictEqual(hero.props.image.video, true, 'asset 7 is a video');
    assert.strictEqual(text.props.image.video, undefined, 'asset 8 claimed video but is a picture');
    assert.deepStrictEqual(gallery.props.images.map((i: any) => !!i.video), [true, false]);
    assert.strictEqual(d.theme.logoAssetId, null);
    assert.strictEqual(removed, 1);
});
check('drawn as a silent looping video a visitor can pause; pictures stay pictures', () => {
    const { definition: d } = markVideos(site, new Set([7]));
    const html = renderSitePage(d, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null, assetUrl: (id: number) => `https://cdn.example/${id}` }).html;
    assert.ok(html.includes('<video src="https://cdn.example/7" autoplay muted loop playsinline controls'), 'hero video');
    assert.ok(html.includes('aria-label="The salon"'));
    assert.ok(html.includes('<img src="https://cdn.example/8" alt="A chair" loading="lazy">'));
    assert.ok(!html.includes('<a href="https://cdn.example/7">'), 'a gallery video is not a link to the file');
});
check('both pages allow media from https; the store marks videos on every save', () => {
    for (const f of ['netlify/functions/site-serve.ts', 'netlify/functions/site-preview.ts']) assert.ok(read(f).includes("media-src https:"), f);
    const store = read('src/utils/site-store.ts');
    assert.ok(store.includes("(r.assetType === 'image' || r.assetType === 'video') && r.status !== 'rejected'") && store.includes('markVideos(withoutAssets(def, drop),'));
});

console.log('\nThe picker');

check('four ways in, named for the assistant; videos only where a video can go', () => {
    const mp = read('src/components/media-picker.js');
    assert.ok(mp.includes("tabBtn('files', 'Upload or library')") && mp.includes("tabBtn('stock', `Ask ${who} to find stock`)") && mp.includes("tabBtn('ai', `Ask ${who} to create one`)"));
    assert.ok(mp.includes("api('pexels-search', { method: 'POST', body: JSON.stringify({ action: 'save', candidate: c, mediaType }) })"));
    assert.ok(mp.includes("api('generate-ai-image'") && mp.includes("api('generate-ai-video'") && mp.includes("api('get-ai-credit-balance'"));
    assert.ok(mp.includes("AI video is on the Busywork Buster and Digital Employee plans."), 'a plan without video says so');
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes("{ k: 'image', kind: 'image', label: 'Picture or video', video: true }"));
    assert.ok(ed.includes("title: 'Choose pictures and videos for your gallery', multiple: true, video: true,"));
    assert.ok(!/title: 'Choose your logo'[^}]*video: true/.test(ed), 'a logo is never a video');
});
check('stock saved to the library only from Pexels\' own addresses', () => {
    assert.ok(isPexelsMediaUrl('https://images.pexels.com/photos/1/a.jpeg'));
    assert.ok(isPexelsMediaUrl('https://videos.pexels.com/video-files/1/a.mp4'));
    assert.ok(!isPexelsMediaUrl('https://evil.example/a.jpg') && !isPexelsMediaUrl('http://images.pexels.com/a.jpg') && !isPexelsMediaUrl('https://images.pexels.com.evil.example/a.jpg'));
    assert.ok(read('netlify/functions/pexels-search.ts').includes("if (body.action === 'save') {"));
});

console.log(`\n${passed}/${total} passed\n`);
