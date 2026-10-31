// tests/image-to-video.test.ts
// Image-to-video (Video Producer plan, Phase 1) — src/lib/fal-gateway.ts + the call sites.
//
// What goes wrong silently if these drift:
//   · Kling's two families take DIFFERENT field names (`image_url` vs `start_image_url`). The wrong
//     one is a 422 at fal — every AI video fails, refunded, and the customer just sees "try again".
//   · Kling v3 makes its own soundtrack unless told not to — it would play under our music bed.
//   · The cost log prices a clip by its BILLED length; a 6 s request on a 5|10 model must log 5 s.
//   · The synchronous endpoint must never draw the FLUX frame (5–15 s inside a ~10 s function).
// No network, no database.
//
// Run:  npx tsx tests/image-to-video.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageToVideoInput, imageToVideoEnabled } from '../src/lib/fal-gateway';
import { mediaCostUsd } from '../src/utils/ai-usage';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const V25 = 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';
const V3 = 'fal-ai/kling-video/v3/pro/image-to-video';

check('Kling v2.5 takes image_url and only 5 or 10 seconds', () => {
    const six = imageToVideoInput(V25, { imageUrl: 'https://x/a.png', prompt: 'slow push-in', durationSeconds: 6 });
    assert.deepStrictEqual(six.input, { prompt: 'slow push-in', image_url: 'https://x/a.png', duration: '5' });
    assert.strictEqual(six.billedSeconds, 5);
    assert.strictEqual(imageToVideoInput(V25, { imageUrl: 'u', prompt: 'p', durationSeconds: 10 }).input.duration, '10');
});

check('Kling v3 takes start_image_url, keeps 6 s, and never makes its own audio', () => {
    const r = imageToVideoInput(V3, { imageUrl: 'https://x/a.png', prompt: 'pan left', durationSeconds: 6 });
    assert.strictEqual(r.input.start_image_url, 'https://x/a.png');
    assert.strictEqual(r.input.image_url, undefined);
    assert.strictEqual(r.input.duration, '6');
    assert.strictEqual(r.input.generate_audio, false);
    assert.strictEqual(imageToVideoInput(V3, { imageUrl: 'u', prompt: 'p', durationSeconds: 40 }).input.duration, '15');
});

check("'off' switches image-to-video off (the Hailuo fallback)", () => {
    assert.strictEqual(imageToVideoEnabled('off'), false);
    assert.strictEqual(imageToVideoEnabled(''), false);
    assert.strictEqual(imageToVideoEnabled(V25), true);
});

check('both Kling models are priced, so the margin view never logs them at $0', () => {
    assert.strictEqual(mediaCostUsd(V25, { durationSeconds: 5 }), '0.350000');
    assert.strictEqual(mediaCostUsd(V25, { durationSeconds: 10 }), '0.700000');
    assert.strictEqual(mediaCostUsd(V3, { durationSeconds: 6 }), '0.840000');
});

check('the synchronous endpoint hands frame drawing to the worker', () => {
    const fn = readFileSync(join(root, 'netlify/functions/generate-ai-video.ts'), 'utf8');
    assert.ok(fn.includes('imageToVideoEnabled() && !startImageUrl'), 'no-picture jobs must be queued for the worker, not drawn here');
    assert.ok(fn.includes('eq(contentAssets.organisationId, orgId)'), 'a picture to animate must belong to the workspace');
    const worker = readFileSync(join(root, 'netlify/functions/process-media-job-background.ts'), 'utf8');
    assert.ok(worker.includes('submitFramedVideo('), 'the worker must submit queued image-to-video jobs');
    assert.ok(worker.includes('falStatusUrl: statusUrl'), 'the worker must write the fal URLs back so a re-run polls instead of paying twice');
    assert.ok(worker.includes('if (!falConfigured()) {'), 'mock mode is "no fal key", no longer "no status URL"');
});

check('briefs log the cost of the model actually billed', () => {
    const src = readFileSync(join(root, 'src/utils/visual-briefs.ts'), 'utf8');
    assert.ok(src.includes('logMediaCost(sub.model, { durationSeconds: sub.billedSeconds }'));
});

console.log(`\n${passed} checks passed`);
