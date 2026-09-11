// tests/overlay-anim.test.ts
// How a text box arrives and leaves (overlayAnimAt in src/lib/overlay-geometry.ts).
//
// Worth testing without a renderer because the failure is invisible until a render comes back: a
// ramp longer than the box's own window means the text never reaches full opacity, which reads as a
// rendering fault rather than a choice, and costs a Lambda render to discover.
//
// Run:  npx tsx tests/overlay-anim.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { overlayAnimAt, readOverlayAnim, OVERLAY_ANIMS, OVERLAY_ANIM_S } from '../src/lib/overlay-geometry';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const FPS = 30;

console.log('\nthe default costs nothing');

check('no animation is exactly the old behaviour', () => {
    for (const f of [0, 5, 30, 90]) {
        assert.deepStrictEqual(overlayAnimAt(undefined, f, 90, FPS), { opacity: 1, transform: 'none' });
    }
});

check('an unknown value degrades to none rather than throwing', () => {
    // Older and newer clients both write this field; neither should be able to break a render.
    assert.strictEqual(readOverlayAnim('wobble'), 'none');
    assert.strictEqual(readOverlayAnim(undefined), 'none');
    assert.deepStrictEqual(overlayAnimAt('wobble' as never, 10, 90, FPS).opacity, 1);
});

console.log('\nfade');

check('it starts invisible, reaches full, and leaves invisible', () => {
    const frames = 90;
    assert.strictEqual(overlayAnimAt('fade', 0, frames, FPS).opacity, 0);
    assert.strictEqual(overlayAnimAt('fade', frames / 2, frames, FPS).opacity, 1);
    assert.strictEqual(overlayAnimAt('fade', frames, frames, FPS).opacity, 0);
});

check('opacity never leaves 0..1 at any frame of any length', () => {
    for (const frames of [3, 11, 45, 300]) {
        for (let f = -5; f <= frames + 5; f++) {
            const { opacity } = overlayAnimAt('fade', f, frames, FPS);
            assert.ok(opacity >= 0 && opacity <= 1, `frames=${frames} f=${f} -> ${opacity}`);
        }
    }
});

console.log('\nthe short-box trap');

check('a box shorter than two ramps still reaches full opacity', () => {
    // The failure this exists to prevent: a 0.4s box with a 0.35s ramp at each end never finishes
    // arriving before it starts leaving, so it is never fully visible — and nothing says why.
    const frames = Math.round(0.4 * FPS);          // 12 frames, shorter than 2 x 0.35s
    let peak = 0;
    for (let f = 0; f <= frames; f++) peak = Math.max(peak, overlayAnimAt('fade', f, frames, FPS).opacity);
    assert.strictEqual(peak, 1, `peaked at ${peak}`);
});

check('the ramp is capped at half the window, whatever the fps', () => {
    for (const fps of [24, 30, 60]) {
        const frames = 10;
        const half = Math.floor(frames / 2);
        // At the midpoint the box must be fully arrived, which is only true if the ramp fits.
        assert.strictEqual(overlayAnimAt('fade', half, frames, fps).opacity, 1, `fps=${fps}`);
    }
    assert.ok(OVERLAY_ANIM_S > 0 && OVERLAY_ANIM_S < 1, 'a ramp measured in seconds, and a short one');
});

console.log('\nrise and pop');

check('rise moves on the way in and settles', () => {
    const frames = 90;
    assert.ok(overlayAnimAt('rise', 0, frames, FPS).transform.includes('translateY'));
    assert.strictEqual(overlayAnimAt('rise', frames / 2, frames, FPS).transform, 'none');
});

check('rise fades out where it is, rather than sinking back down', () => {
    // Leaving by the way it came in reads as the text falling over.
    const frames = 90;
    const out = overlayAnimAt('rise', frames - 2, frames, FPS);
    assert.strictEqual(out.transform, 'none');
    assert.ok(out.opacity < 1);
});

check('pop overshoots and settles at exactly 1', () => {
    const frames = 90;
    const scales: number[] = [];
    for (let f = 0; f <= 12; f++) {
        const m = /scale\(([\d.]+)\)/.exec(overlayAnimAt('pop', f, frames, FPS).transform);
        if (m) scales.push(Number(m[1]));
    }
    assert.ok(scales.some(v => v > 1), 'it should overshoot — that is what makes it a pop');
    assert.strictEqual(overlayAnimAt('pop', frames / 2, frames, FPS).transform, 'none', 'and settle');
});

console.log('\nthe two copies of the list');

check('the editor offers exactly the animations the renderer knows', () => {
    // image-overlay-editor.js is an unbundled IIFE and cannot import the module, so it keeps its own
    // list. A name that drifts is stored happily and ignored silently by the renderer.
    const ioe = readFileSync(join(import.meta.dirname, '..', 'src/components/image-overlay-editor.js'), 'utf8');
    for (const a of OVERLAY_ANIMS) {
        assert.ok(new RegExp(`id: '${a.id}'`).test(ioe), `the editor is missing '${a.id}'`);
    }
    const ids = [...ioe.matchAll(/\{ id: '(\w+)', label: '[^']+' \}/g)].map(m => m[1]);
    assert.deepStrictEqual(ids.sort(), OVERLAY_ANIMS.map(a => a.id).sort(), 'the two lists must agree');
});

check('the server stores only names the renderer understands', () => {
    const save = readFileSync(join(import.meta.dirname, '..', 'netlify/functions/save-post-overlays.ts'), 'utf8');
    for (const a of OVERLAY_ANIMS) assert.ok(save.includes(`'${a.id}'`), `save rejects '${a.id}'`);
});

console.log(`\n${passed} checks passed`);
