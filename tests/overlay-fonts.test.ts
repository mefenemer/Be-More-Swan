// tests/overlay-fonts.test.ts
// The typeface catalogue behind text overlays (src/lib/overlay-fonts.ts).
//
// Worth testing because the failure it exists to prevent is invisible: Lambda has none of the OS
// fonts the picker offered, substituted silently, and published a video set in a different face —
// with a differently sized box, since the box is sized by the rendered text. Nothing errors. The
// only signal is someone noticing the published post does not match the preview.
//
// Run:  npx tsx tests/overlay-fonts.test.ts

import assert from 'node:assert';
import {
    OVERLAY_FONTS, DEFAULT_OVERLAY_FONT, ALL_OVERLAY_GOOGLE_FAMILIES,
    overlayFont, overlayFontStack, googleFamiliesFor, googleFontsHref,
} from '../src/lib/overlay-fonts';
import { overlayBoxStyle } from '../src/lib/overlay-geometry';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// The nine names the picker offered before webfonts existed. Every one of them is sitting in
// image_overlays on already-scheduled posts, so every one must still resolve to a real entry.
const LEGACY_IDS = [
    'Arial', 'Helvetica', 'Verdana', 'Trebuchet MS', 'Georgia',
    'Times New Roman', 'Courier New', 'Impact', 'Comic Sans MS',
];

console.log('\nthe catalogue');

check('every id the picker ever offered still resolves to its own entry', () => {
    for (const id of LEGACY_IDS) {
        assert.strictEqual(overlayFont(id).id, id, `${id} no longer resolves to itself`);
    }
});

check('ids are unique and non-empty', () => {
    const ids = OVERLAY_FONTS.map(f => f.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(ids.every(i => i.trim().length));
});

check('an unknown or missing name falls back to the default rather than throwing', () => {
    assert.strictEqual(overlayFont('Wingdings').id, DEFAULT_OVERLAY_FONT.id);
    assert.strictEqual(overlayFont(null).id, DEFAULT_OVERLAY_FONT.id);
    assert.strictEqual(overlayFont('').id, DEFAULT_OVERLAY_FONT.id);
});

check('lookup is case- and space-insensitive', () => {
    assert.strictEqual(overlayFont('  arial  ').id, 'Arial');
    assert.strictEqual(overlayFont('IMPACT').id, 'Impact');
});

console.log('\nthe stacks');

check('every stack names its webfont FIRST', () => {
    // If the OS face came first, a Mac would keep using Arial while Lambda used Arimo — which is
    // the divergence, restored.
    for (const f of OVERLAY_FONTS) {
        const first = f.stack.split(',')[0].trim().replace(/^'|'$/g, '');
        assert.strictEqual(first, f.google, `${f.id} leads with ${first}, not ${f.google}`);
    }
});

check('every stack ends in a generic family that always resolves', () => {
    const generics = ['sans-serif', 'serif', 'monospace', 'cursive'];
    for (const f of OVERLAY_FONTS) {
        const last = f.stack.split(',').pop()!.trim();
        assert.ok(generics.includes(last), `${f.id} ends in "${last}"`);
    }
});

check('the four true metric clones are flagged, and only those', () => {
    // These are the ones where a failed download is harmless: same advance widths, same box.
    const clones = OVERLAY_FONTS.filter(f => f.metricClone).map(f => f.id).sort();
    assert.deepStrictEqual(clones, ['Arial', 'Courier New', 'Georgia', 'Helvetica', 'Times New Roman'].sort());
});

check('a metric clone keeps the OS face it clones as its immediate fallback', () => {
    for (const f of OVERLAY_FONTS.filter(x => x.metricClone)) {
        assert.ok(f.stack.includes(f.id), `${f.id} must fall back to itself`);
    }
});

console.log('\nthe stylesheet URL');

check('families are de-duplicated — Arial and Helvetica share one download', () => {
    assert.deepStrictEqual(googleFamiliesFor(['Arial', 'Helvetica']), ['Arimo']);
});

check('only the families actually used are requested', () => {
    assert.deepStrictEqual(googleFamiliesFor(['Impact']), ['Anton']);
    assert.deepStrictEqual(googleFamiliesFor([]), []);
});

check('no families means no stylesheet, so a render with no text waits for nothing', () => {
    assert.strictEqual(googleFontsHref([]), null);
});

check('spaces are encoded the way Google Fonts expects', () => {
    const href = googleFontsHref(['Open Sans'])!;
    assert.ok(href.includes('family=Open+Sans'), href);
    assert.ok(!href.includes('%20'), 'a percent-encoded space 400s the whole stylesheet');
});

check('no weight is requested at all', () => {
    // An overlay has no bold control, and Anton publishes a single weight — a wght@400;700 on it is
    // a 400 from Google, which fails the WHOLE stylesheet and silently restores the fallbacks.
    assert.ok(!googleFontsHref(ALL_OVERLAY_GOOGLE_FAMILIES)!.includes('wght'));
});

console.log('\nthe geometry builder uses it');

check('overlayBoxStyle emits the stack, not the bare stored name', () => {
    const style = overlayBoxStyle({ fontFamily: 'Impact', fontSizePct: 0.07 }, 1920);
    assert.strictEqual(style.fontFamily, overlayFontStack('Impact'));
    assert.ok(String(style.fontFamily).startsWith(`'Anton'`), String(style.fontFamily));
});

check('an overlay with no font still gets the default stack', () => {
    const style = overlayBoxStyle({ fontSizePct: 0.07 }, 1920);
    assert.strictEqual(style.fontFamily, DEFAULT_OVERLAY_FONT.stack);
});

console.log(`\n${passed} checks passed`);
