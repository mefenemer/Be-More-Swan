// tests/still-motion.test.ts
// Slow movement on stills (Video Producer plan, Phase 4) — src/lib/still-motion.ts, the job input,
// the worker, the weekly Short and the composition.
//
// What goes wrong silently if these drift:
//   · a pan that uncovers the frame edge (scale too small for the travel) — a black sliver slides in
//   · a forced-render RETRY dropping the movement, so "try again" gives a stiller Short
//   · the composition requiring imageMotion, so an old job's input fails on the new bundle
// No network, no database, no renderer.
//
// Run:  npx tsx tests/still-motion.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stillMotionAt, stillMotionTransform, easeInOut, isStillMotion, STILL_MOTION_STRENGTH } from '../src/lib/still-motion';
import { readStillMotion } from '../src/lib/post-render';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

check('push-in grows from 1 to 1+strength; pull-out the reverse', () => {
    assert.ok(near(stillMotionAt('push_in', 0).scale, 1));
    assert.ok(near(stillMotionAt('push_in', 1).scale, 1 + STILL_MOTION_STRENGTH));
    assert.ok(near(stillMotionAt('pull_out', 0).scale, 1 + STILL_MOTION_STRENGTH));
    assert.ok(near(stillMotionAt('pull_out', 1).scale, 1));
});

check('a pan never uncovers the frame: travel stays inside the zoom overflow', () => {
    for (const m of ['pan_left', 'pan_right'] as const) {
        for (let p = 0; p <= 1; p += 0.1) {
            const { scale, xPct } = stillMotionAt(m, p);
            // scale(s) translate(x%): the shift on screen is s·x% of the frame; the overflow each side
            // is (s − 1)/2 of it. The shift may never exceed the overflow.
            assert.ok(scale * Math.abs(xPct) <= ((scale - 1) / 2) * 100 + 1e-9, `${m} at ${p.toFixed(1)} uncovers the edge`);
        }
    }
    assert.ok(stillMotionAt('pan_left', 0).xPct > 0 && stillMotionAt('pan_left', 1).xPct < 0);
    assert.ok(stillMotionAt('pan_right', 0).xPct < 0 && stillMotionAt('pan_right', 1).xPct > 0);
});

check('the move eases in and out, and none/unknown stays put', () => {
    assert.strictEqual(easeInOut(0), 0);
    assert.strictEqual(easeInOut(1), 1);
    assert.ok(easeInOut(0.1) < 0.1 && easeInOut(0.9) > 0.9);
    assert.deepStrictEqual(stillMotionAt('none', 0.5), { scale: 1, xPct: 0, yPct: 0 });
    assert.deepStrictEqual(stillMotionAt(undefined, 0.5), { scale: 1, xPct: 0, yPct: 0 });
    assert.ok(stillMotionTransform('push_in', 0.5).startsWith('scale('));
});

check('the job input is read defensively', () => {
    assert.strictEqual(readStillMotion({ stillMotion: 'pan_left' }), 'pan_left');
    assert.strictEqual(readStillMotion({ stillMotion: 'spin' }), 'none');
    assert.strictEqual(readStillMotion(null), 'none');
    assert.ok(isStillMotion('push_in') && !isStillMotion(''));
});

check('the weekly Short pushes in, a retry keeps the move, the worker passes it only for stills', () => {
    const jobs = readFileSync(join(root, 'netlify/functions/process-content-jobs.ts'), 'utf8');
    assert.ok(jobs.includes("stillMotion: 'push_in',"));
    const trig = readFileSync(join(root, 'netlify/functions/trigger-post-render.ts'), 'utf8');
    assert.ok(trig.includes('priorMotion = readStillMotion(prior?.renderInput);'), 'a forced retry must keep the movement');
    const worker = readFileSync(join(root, 'netlify/functions/render-post-video-background.ts'), 'utf8');
    // A still backdrop is "not a timeline" since Phase 5 (a storyboard can open on a picture).
    assert.ok(worker.includes("!useTimeline && readStillMotion(job.renderInput) !== 'none'"));
});

check('the composition treats imageMotion as optional and keeps contain for a still that stays put', () => {
    const tsx = readFileSync(join(root, 'remotion/PostOverlay.tsx'), 'utf8');
    assert.ok(tsx.includes('imageMotion?: StillMotion;'));
    assert.ok(tsx.includes("imageMotion && imageMotion !== 'none'"));
    assert.ok(tsx.includes("objectFit: 'contain'"), 'an unmoving still is still letterboxed, not cropped');
    assert.ok(!/from ['"](node:|fs|path|drizzle)/.test(readFileSync(join(root, 'src/lib/still-motion.ts'), 'utf8')));
});

console.log(`\n${passed} checks passed`);
