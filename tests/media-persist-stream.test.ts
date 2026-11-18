// tests/media-persist-stream.test.ts
// Phase 4a (docs/video-producer-screen-walkthrough-plan.md §12): a rendered video is streamed into R2, not
// held in memory — a 10-minute 1080p MP4 can be several hundred MB.
//
// Run:  npx tsx tests/media-persist-stream.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamableSize } from '../src/lib/media-persist';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('streams only when asked, with a body and a usable Content-Length', () => {
    assert.strictEqual(streamableSize(true, '612000000', true), 612000000);
    assert.strictEqual(streamableSize(true, ' 42 ', true), 42);
    assert.strictEqual(streamableSize(undefined, '42', true), null, 'not asked: buffer as before');
    assert.strictEqual(streamableSize(false, '42', true), null);
    assert.strictEqual(streamableSize(true, null, true), null, 'no length: S3 needs the size up front');
    assert.strictEqual(streamableSize(true, '42', false), null, 'no body');
    for (const junk of ['', '0', '-5', '1e9', 'abc', '99999999999999999999']) assert.strictEqual(streamableSize(true, junk, true), null, junk);
});

check('both render workers stream their output', () => {
    assert.match(read('src/utils/video-render.ts'), /label: 'finished video', stream: true \}\)/);
    assert.match(read('netlify/functions/render-post-video-background.ts'), /stream: true,\n\s*\}\);/);
});

console.log(`\n${passed} checks passed.`);
