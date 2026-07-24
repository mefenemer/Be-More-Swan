// tests/overlay-geometry.test.ts
// The overlay box geometry lives in TWO places that MUST agree, or a text box lands in a different
// spot in the published media than the user dragged it to:
//   1. src/lib/overlay-geometry.ts        — imported by the Remotion video render (and this test)
//   2. src/components/image-overlay-editor.js — the browser editor, a static IIFE that cannot import
//      the module, so it keeps an inline copy of the same constants.
// This test reads the editor's source and asserts its constants equal the module's. If someone tunes
// a ratio in one place, this goes red until the other is updated to match.
//
// Run:  npx tsx tests/overlay-geometry.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    PAD_RATIO, LINE_HEIGHT, BORDER_RATIO, RADIUS_RATIO,
    OVERLAY_DEFAULTS, overlayBoxStyle, overlayVisibleAt, overlayFrameRange, hexToRgba,
} from '../src/lib/overlay-geometry';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const EDITOR_SRC = readFileSync(new URL('../src/components/image-overlay-editor.js', import.meta.url), 'utf8');

// Pull `const NAME = 0.30;` out of the editor source.
function editorConst(name: string): number {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)`).exec(EDITOR_SRC);
    if (!m) throw new Error(`could not find ${name} in image-overlay-editor.js`);
    return Number(m[1]);
}

check('the editor and the module share one set of box ratios', () => {
    assert.equal(editorConst('PAD_RATIO'), PAD_RATIO, 'PAD_RATIO drifted');
    assert.equal(editorConst('LINE_HEIGHT'), LINE_HEIGHT, 'LINE_HEIGHT drifted');
    assert.equal(editorConst('BORDER_RATIO'), BORDER_RATIO, 'BORDER_RATIO drifted');
    assert.equal(editorConst('RADIUS_RATIO'), RADIUS_RATIO, 'RADIUS_RATIO drifted');
});

check('the editor and the module share one set of overlay defaults', () => {
    // The editor declares DEFAULTS as an object literal; assert the fields this test cares about.
    assert.match(EDITOR_SRC, /fontSizePct:\s*0\.07/, 'default fontSizePct drifted');
    assert.equal(OVERLAY_DEFAULTS.fontSizePct, 0.07);
    assert.match(EDITOR_SRC, /color:\s*'#ffffff'/, 'default colour drifted');
    assert.equal(OVERLAY_DEFAULTS.color, '#ffffff');
    assert.match(EDITOR_SRC, /boxOpacity:\s*0\.5/, 'default box opacity drifted');
    assert.equal(OVERLAY_DEFAULTS.boxOpacity, 0.5);
});

check('overlayBoxStyle reproduces the editor maths at a known height', () => {
    // A 0.07 font on a 1000px-tall frame = 70px, padding 21px, radius 10.5px, no border (min 1 only
    // when boxStroke is set), black fill at 50%.
    const s = overlayBoxStyle(
        { x: 0.5, y: 0.2, fontSizePct: 0.07, color: '#ffffff', boxFill: '#000000', boxOpacity: 0.5, boxStroke: null },
        1000,
    );
    assert.equal(s.fontSize, '70px');
    assert.equal(s.padding, '21px');
    assert.equal(s.borderRadius, '10.5px');
    assert.equal(s.left, '50%');
    assert.equal(s.top, '20%');
    assert.equal(s.border, 'none');
    assert.equal(s.background, 'rgba(0,0,0,0.5)');
    assert.equal(s.transform, 'translate(-50%, -50%)');
});

check('a stroked box gets a border at least 1px, scaled by font size', () => {
    // Border width is left UNROUNDED so it matches the editor's inline maths byte-for-byte (rounding
    // in only one of the two would reintroduce the drift this module exists to prevent), so parse the
    // number out and compare with tolerance rather than asserting the exact float string.
    const borderPx = (style: Record<string, string | number>) => {
        const m = /^([0-9.]+)px solid (#[0-9a-f]{6})$/i.exec(String(style.border));
        assert.ok(m, `unexpected border shape: ${style.border}`);
        return { px: Number(m![1]), colour: m![2] };
    };
    const big = borderPx(overlayBoxStyle({ fontSizePct: 0.1, boxStroke: '#ec4899' }, 1000));   // 100px → 7px
    assert.ok(Math.abs(big.px - 7) < 1e-6, `expected ~7px, got ${big.px}`);
    assert.equal(big.colour, '#ec4899');
    const tiny = borderPx(overlayBoxStyle({ fontSizePct: 0.01, boxStroke: '#ec4899' }, 1000));  // 10px → 0.7 → min 1
    assert.equal(tiny.px, 1);
});

check('junk placement values are clamped, never passed through', () => {
    const s = overlayBoxStyle({ x: 9, y: -3, fontSizePct: 99 }, 1000);
    assert.equal(s.left, '100%');
    assert.equal(s.top, '0%');
    assert.equal(s.fontSize, '500px');   // FONT_MAX 0.5 * 1000
});

check('overlayVisibleAt treats absent bounds as "always"', () => {
    assert.equal(overlayVisibleAt({}, 0), true);
    assert.equal(overlayVisibleAt({}, 9999), true);
    // Half-open [start, end): shows at start, hidden exactly at end.
    assert.equal(overlayVisibleAt({ startS: 2, endS: 5 }, 1.9), false);
    assert.equal(overlayVisibleAt({ startS: 2, endS: 5 }, 2), true);
    assert.equal(overlayVisibleAt({ startS: 2, endS: 5 }, 4.99), true);
    assert.equal(overlayVisibleAt({ startS: 2, endS: 5 }, 5), false);
    // Only a start, or only an end.
    assert.equal(overlayVisibleAt({ startS: 3 }, 2), false);
    assert.equal(overlayVisibleAt({ startS: 3 }, 3), true);
    assert.equal(overlayVisibleAt({ endS: 4 }, 3.9), true);
    assert.equal(overlayVisibleAt({ endS: 4 }, 4), false);
});

check('overlayFrameRange maps seconds to a Sequence window, clamped inside the clip', () => {
    // 30fps, 150-frame (5s) clip.
    // Whole clip when unbounded.
    assert.deepEqual(overlayFrameRange({}, 30, 150), { from: 0, durationInFrames: 150 });
    // [1s, 3s) → frames 30..90 → from 30, length 60.
    assert.deepEqual(overlayFrameRange({ startS: 1, endS: 3 }, 30, 150), { from: 30, durationInFrames: 60 });
    // Only a start: runs to the end of the clip.
    assert.deepEqual(overlayFrameRange({ startS: 2 }, 30, 150), { from: 60, durationInFrames: 90 });
    // Only an end: from frame 0.
    assert.deepEqual(overlayFrameRange({ endS: 2 }, 30, 150), { from: 0, durationInFrames: 60 });
    // endS past the clip is clamped to the clip (the box is timed longer than the video is).
    assert.deepEqual(overlayFrameRange({ startS: 4, endS: 99 }, 30, 150), { from: 120, durationInFrames: 30 });
    // A start at/after the very end still yields a visible 1-frame window rather than vanishing.
    const r = overlayFrameRange({ startS: 10 }, 30, 150);
    assert.ok(r.from <= 149 && r.durationInFrames >= 1, `degenerate window: ${JSON.stringify(r)}`);
    // Rounds to the nearest frame (0.05s at 30fps ≈ 1.5 → 2).
    assert.equal(overlayFrameRange({ startS: 0.05 }, 30, 150).from, 2);
});

check('hexToRgba parses hex and falls back to opaque black on junk', () => {
    assert.equal(hexToRgba('#ff007f', 0.5), 'rgba(255,0,127,0.5)');
    assert.equal(hexToRgba('ff007f', 1), 'rgba(255,0,127,1)');
    assert.equal(hexToRgba('not-a-colour', 0.3), 'rgba(0,0,0,0.3)');
    assert.equal(hexToRgba(null, 1), 'rgba(0,0,0,1)');
});

console.log(`\n${passed}/8 passed`);
