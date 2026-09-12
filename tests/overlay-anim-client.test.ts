// tests/overlay-anim-client.test.ts
//
// The browser's copy of overlayAnimAt must agree with the renderer's, to the last decimal.
//
// ── Why this is a test rather than a comment ────────────────────────────────────────────────────
// The canvas preview used to only toggle boxes on and off, so choosing Fade, Rise or Pop changed
// nothing you could see until the video came back from Lambda — three options that appeared to do
// nothing. Making the preview animate means the maths exists twice: once in TypeScript for Remotion,
// once in generated JS for the unbundled page.
//
// Two copies of a formula is the same setup that gave us the font divergence — a preview that is
// approved and a video that is not the one approved. There the fix was one FILE for both; here the
// browser cannot import TypeScript, so the fix is one GENERATOR plus this: a sweep across every
// animation, every ramp position and several window lengths, asserting the two are identical.
//
// Run:  npx tsx tests/overlay-anim-client.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { overlayAnimAt, OVERLAY_ANIMS, OVERLAY_ANIM_S, readOverlayAnim } from '../src/lib/overlay-geometry';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// The generated file is a browser script: give it a window and let it attach. require, not import,
// because the test runner compiles to CJS and has no top-level await.
const g = globalThis as unknown as { window?: Record<string, unknown> };
g.window = g.window || {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../src/generated/platform-constants.js');
const client = (g.window as Record<string, any>).OverlayAnims;

console.log('\nthe browser has the maths at all');

check('the generated file exposes it', () => {
    assert.ok(client, 'window.OverlayAnims is missing — run npm run gen:constants');
    assert.strictEqual(typeof client.at, 'function');
    assert.strictEqual(client.RAMP_S, OVERLAY_ANIM_S, 'the ramp length drifted');
    assert.deepStrictEqual(
        client.OPTIONS.map((o: { id: string }) => o.id),
        OVERLAY_ANIMS.map(o => o.id),
        'the option list drifted',
    );
});

check('unknown values fall back the same way', () => {
    for (const v of ['', 'wobble', 'FADE', null, undefined, 7]) {
        assert.strictEqual(client.read(v as string), readOverlayAnim(v),
            `disagreed on ${JSON.stringify(v)}`);
    }
});

console.log('\nand it agrees with the renderer everywhere');

check('every animation, every frame of several windows, identical', () => {
    const fps = 30;
    let compared = 0;
    for (const { id } of OVERLAY_ANIMS) {
        // Short windows are where the half-window ramp cap bites, which is the fiddly part.
        for (const frames of [1, 2, 5, 11, 21, 60, 300]) {
            for (let frame = -2; frame <= frames + 2; frame++) {
                const a = overlayAnimAt(id, frame, frames, fps);
                const b = client.at(id, frame, frames, fps);
                assert.strictEqual(b.opacity, a.opacity,
                    `${id} opacity at frame ${frame}/${frames}: ${b.opacity} vs ${a.opacity}`);
                assert.strictEqual(b.transform, a.transform,
                    `${id} transform at frame ${frame}/${frames}: ${b.transform} vs ${a.transform}`);
                compared++;
            }
        }
    }
    assert.ok(compared > 500, `only compared ${compared} frames`);
});

check('other frame rates too — the ramp is in seconds, not frames', () => {
    for (const fps of [24, 25, 30, 50, 60]) {
        for (const { id } of OVERLAY_ANIMS) {
            for (const frame of [0, 1, 3, 7, 15, 29]) {
                const a = overlayAnimAt(id, frame, 90, fps);
                const b = client.at(id, frame, 90, fps);
                assert.deepStrictEqual(b, a, `${id} at ${fps}fps frame ${frame}`);
            }
        }
    }
});

console.log('\nthe page actually uses it');

check('the canvas applies the animation, and keeps the centring transform', () => {
    // ⚠️ .ioe-ov is centred with transform:translate(-50%,-50%) from the stylesheet. Writing an
    // inline transform REPLACES that, so an animation applied naively puts every box a half-width
    // up and to the left — which is how the Remotion side broke before AnimatedBox was introduced.
    const ws = readFileSync(join(import.meta.dirname, '..', 'workspace.html'), 'utf8');
    assert.ok(ws.includes('window.OverlayAnims'), 'the page never reaches for the shared maths');
    assert.ok(ws.includes('translate(-50%,-50%)'),
        'an inline transform without the centring would move every animated box');
});

console.log(`\n${passed} checks passed`);
