// tests/image-plan-words.test.ts
// Picture first, words second (owner, 2026-11-02). FLUX can't spell, so a request for words ON a
// picture is split: a scene for FLUX, and the exact words as editable text layers drawn by us.
// Also: regenerating a post's image used to leave its text layers based on the OLD picture, so the
// approve bake published the old image.
//
// Run:  npx tsx tests/image-plan-words.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseImagePlan, wordsToOverlays, wrapWords, MAX_IMAGE_WORDS } from '../src/lib/image-prompt';
import { bakeWordsOnImage, canBakeOnto, type WordLayer } from '../src/lib/bake-words';
import { Resvg } from '@resvg/resvg-js';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

console.log('image plan: scene + words');

const SCENE = 'A sunlit craft table with a half-finished felt cat beside a finished one, soft window light.';
const REQ = 'Split image, left labelled "Before", right labelled "After: ready for its new home"';

test('keeps words that are really in the request', () => {
    const p = parseImagePlan(JSON.stringify({ scene: SCENE, words: ['Before', 'After: ready for its new home'] }), REQ);
    assert.deepStrictEqual(p, { scene: SCENE, words: ['Before', 'After: ready for its new home'] });
});

test('drops words the model wrote itself (it copies, never writes copy)', () => {
    const p = parseImagePlan(JSON.stringify({ scene: SCENE, words: ['Before', 'Handmade with love!'] }), REQ);
    assert.deepStrictEqual(p?.words, ['Before']);
});

test('quote marks and spacing differences still match', () => {
    const p = parseImagePlan(`{"scene": "${SCENE}", "words": ["“Before”"]}`, REQ);
    assert.deepStrictEqual(p?.words, ['“Before”']);
});

test('caps the words and survives prose around the JSON', () => {
    const many = Array.from({ length: 9 }, (_, i) => `w${i}`);
    const p = parseImagePlan(`Here you go: ${JSON.stringify({ scene: SCENE, words: many })} done`, many.join(' '));
    assert.strictEqual(p?.words.length, MAX_IMAGE_WORDS);
});

test('unusable replies are null (caller fails open to the request)', () => {
    assert.strictEqual(parseImagePlan('no json here', REQ), null);
    assert.strictEqual(parseImagePlan('{"scene": "short", "words": []}', REQ), null);
    assert.strictEqual(parseImagePlan('{"scene": ', REQ), null);
});

test('wraps long lines at word boundaries (the editor never wraps)', () => {
    const w = wrapWords('After: ready for its new home with a family who loves it', 26);
    for (const row of w.split('\n')) assert.ok(row.length <= 26, row);
    assert.strictEqual(w.replace(/\n/g, ' '), 'After: ready for its new home with a family who loves it');
});

test('words become save-post-overlays layers: centred, headline high, stacked', () => {
    assert.deepStrictEqual(wordsToOverlays([]), []);
    const one = wordsToOverlays(['Before']);
    assert.strictEqual(one.length, 1);
    assert.strictEqual(one[0].x, 0.5);
    assert.strictEqual(one[0].y, 0.15);
    const two = wordsToOverlays(['Before', 'After']);
    assert.deepStrictEqual(two.map((o) => o.y), [0.15, 0.85]);
    assert.ok((two[0].fontSizePct as number) > (two[1].fontSizePct as number), 'first is the headline');
    for (const o of two) for (const k of ['id', 'text', 'fontFamily', 'color', 'boxFill', 'boxOpacity']) assert.ok(k in o, k);
});

console.log('regenerate-post-media + editor');
const fn = read('netlify/functions/regenerate-post-media.ts');
const ws = read('workspace.html');

test('regenerate plans the image, never sends the request straight to FLUX', () => {
    assert.match(fn, /const \{ scene: prompt, words \} = await planImage\(request/);
    assert.ok(!/visualisePrompt\(/.test(fn));
});

test('a caption never becomes words on the picture', () => {
    assert.match(fn, /const fromCaption = request === \(post\.caption \|\| ''\)\.trim\(\)\.slice\(0, 1000\)/);
    assert.match(fn, /const overlays = fromCaption \? \[\] : wordsToOverlays\(words\)/);
});

test('regenerate rebases text layers onto the NEW asset, or clears them', () => {
    assert.match(fn, /imageOverlays: overlays\.length \? overlays : null/);
    assert.match(fn, /overlayBaseAssetId: overlays\.length \? assetId : null/);
    assert.match(fn, /postIds: targetIds, overlays \}/);
});

test('editor puts the returned layers in the cache after the swap emptied it', () => {
    const at = ws.indexOf("fetch('/.netlify/functions/regenerate-post-media'");
    assert.ok(at > 0);
    const win = ws.slice(at, at + 2500);
    const thumb = win.indexOf("gpAiShowThumb(d.thumbnailUrl, 'image')");
    const fill = win.indexOf('_rqPostCache[id].overlays = planned');
    assert.ok(thumb > 0 && fill > thumb, 'layers are set AFTER gpAiShowThumb clears them');
    assert.match(win, /_gpOverlayCountByPost\[id\] = planned\.length/);
});

test('rows fit the picture: a tall 9:16 wraps shorter than a wide 16:9', () => {
    const long = 'Made by hand, one stab at a time, every single day';
    const rows = (a: number) => String(wordsToOverlays([long], a)[0].text).split('\n');
    assert.ok(rows(9 / 16).length > rows(16 / 9).length);
    for (const a of [9 / 16, 0.8, 1, 16 / 9]) {
        const o = wordsToOverlays([long], a)[0];
        const longest = Math.max(...rows(a).map((r) => r.length));
        assert.ok(longest * 0.56 * (o.fontSizePct as number) <= 0.85 * a + 1e-9, `fits at aspect ${a}`);
    }
});

console.log('Create with AI: words drawn on at save');
const gen = read('netlify/functions/generate-ai-image.ts');

test('plans words alongside the four scenes, in parallel (no extra wait)', () => {
    assert.match(gen, /await Promise\.all\(\[\s*falConfigured\(\) \? visualisePrompts\(prompt, 4, usage\)[\s\S]{0,80}planImage\(prompt, usage\)/);
    assert.match(gen, /contentType: i\.contentType, words \}/);
    assert.match(gen, /\n\s+words,\n\s+balance: balance\.balance/);
});

test('select draws the words on, can be told not to, and says whether it did', () => {
    assert.match(gen, /handleSelect\(db, orgId, userId, body\.jobId, body\.index, body\.words !== false\)/);
    assert.match(gen, /bytes = await bakeWordsOnImage\(/);
    assert.match(gen, /wordsAdded, url: wordsAdded && storageKey/);
});

test('every Create with AI page shows the words and previews what was saved', () => {
    const mc = read('my-content.js');
    assert.match(mc, /_mcAiShowWords\(resultsEl, words\)/);
    assert.match(mc, /words: document\.getElementById\('ai-words-on'\)\?\.checked !== false/);
    const mp = read('src/components/media-picker.js');
    assert.match(mp, /showWords\(res\.body\.words\)/);
    assert.match(mp, /url: res\.body\.url \|\| b\.dataset\.url/);
    const bs = read('src/components/blog-studio-modal.js');
    assert.match(bs, /var words = \(res\.body\.words \|\| \[\]\)/);
    assert.match(bs, /url: sel\.body\.url \|\| im\.url/);
});

test('only JPEG and PNG are drawn on', () => {
    assert.ok(canBakeOnto('image/jpeg') && canBakeOnto('image/png; charset=binary'));
    assert.ok(!canBakeOnto('image/webp') && !canBakeOnto(null));
});

(async () => {
    total++;
    try {
        // A plain 400x500 PNG to draw on — made by resvg itself, so the test needs no network.
        const base = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#3a6"/></svg>').render().asPng());
        const png = await bakeWordsOnImage({ bytes: base, mimeType: 'image/png', width: 400, height: 500,
            layers: wordsToOverlays(['Before', 'After'], 0.8) as unknown as WordLayer[] });
        assert.strictEqual(png.subarray(1, 4).toString(), 'PNG');
        assert.strictEqual(png.readUInt32BE(16), 400, 'keeps the width');
        assert.strictEqual(png.readUInt32BE(20), 500, 'keeps the height');
        assert.ok(png.length > base.length, 'something was drawn on');
        passed++; console.log('  ✓ draws words onto a real picture at its own size');
    } catch (err) { console.error(`  ✗ draws words onto a real picture\n    ${(err as Error).message}`); }
    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exit(1);
})();
