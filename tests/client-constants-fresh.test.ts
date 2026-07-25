// tests/client-constants-fresh.test.ts
//
// src/generated/platform-constants.js must match what scripts/gen-client-constants.ts would write
// from src/config/platform-formats.ts right now.
//
// The site has NO build step — the committed file is what the browser loads. So changing a platform
// fact in TypeScript without regenerating leaves the browser running the old values, which is the
// exact drift this generator was introduced to end (see platform-allowlist.test.ts for the bugs it
// caused when the mirrors were written by hand). Failing here is the only thing standing between a
// one-line config edit and a silently stale UI.
//
// If this fails:  npm run gen:constants   — then commit the result.
//
// Run:  npx tsx tests/client-constants-fresh.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { renderClientConstants, OUTPUT_PATH } from '../scripts/gen-client-constants';
import { PLATFORM_FORMATS, SOCIAL_PLATFORMS } from '../src/config/platform-formats';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

console.log('\nGenerated client constants are in step with the source\n');

test('the generated file exists', () => {
    assert.ok(existsSync(OUTPUT_PATH), `${OUTPUT_PATH} is missing — run: npm run gen:constants`);
});

test('the committed file matches a fresh generation', () => {
    const onDisk = readFileSync(OUTPUT_PATH, 'utf8');
    assert.equal(
        onDisk,
        renderClientConstants(),
        'src/generated/platform-constants.js is stale. Run `npm run gen:constants` and commit the result.',
    );
});

test('every platform reaches the browser with its real values', () => {
    // Guards against the generator quietly dropping or flattening a field.
    const js = readFileSync(OUTPUT_PATH, 'utf8');
    for (const id of SOCIAL_PLATFORMS) {
        const f = PLATFORM_FORMATS[id];
        assert.ok(js.includes(`"id":"${id}"`), `${id} missing from the generated file`);
        assert.ok(js.includes(`"charLimit":${f.charLimit}`), `${id} char limit missing`);
    }
    // Every platform can publish video now that all six drivers exist. Assert the flag SURVIVES the
    // trip rather than asserting a particular value: it is a kill switch, and the day a driver has
    // to be pulled the browser must learn about it from here.
    for (const id of SOCIAL_PLATFORMS) {
        const f = PLATFORM_FORMATS[id];
        assert.ok(
            js.includes(`"id":"${id}","label":"${f.label}","charLimit":${f.charLimit},"aspectRatio":"${f.aspectRatio}","mediaMandatory":${f.mediaMandatory},"mediaKind":"${f.mediaKind}","canPublishVideo":${f.canPublishVideo}`),
            `${id} does not reach the browser with its real values`,
        );
    }
});

test('workspace.html loads it, and no longer hand-writes the values', () => {
    const html = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
    assert.ok(
        html.includes('/src/generated/platform-constants.js'),
        'workspace.html must load the generated constants',
    );
    // The specific literals that used to drift. Their absence is the point of the whole exercise.
    for (const stale of ['_GPW_PLATFORM_LABELS = {', '_PCE_VIDEO_PLATFORMS = [', 'charLimit: 2200']) {
        assert.ok(!html.includes(stale), `workspace.html still hand-writes ${stale}`);
    }
});

test('the script tag comes before anything that reads it', () => {
    const html = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
    const loaded = html.indexOf('/src/generated/platform-constants.js');
    // Match a real CALL, not the prose — the comment above the script tag names the global too, and
    // matching that made this assertion fail on correct markup.
    const firstUse = html.search(/window\.PlatformConstants\.(all|get|label|charLimit|canPublishVideo|mediaMandatory)\b/);
    assert.ok(loaded > -1, 'the generated script is never loaded');
    assert.ok(firstUse > -1, 'nothing actually reads PlatformConstants');
    assert.ok(loaded < firstUse, 'PlatformConstants is read before the script that defines it is loaded');
});

console.log(`\n${passed}/5 passed\n`);
