// tests/platform-allowlist.test.ts
// Every platform the composer offers must be one the drafting endpoints accept.
//
// This is the bug this file exists to stop recurring: the composer listed six platforms while
// generate-post.ts and create-manual-post.ts each carried their own hand-written list of four.
// Choosing Threads or YouTube alone failed with "No recognised platform selected"; choosing them
// ALONGSIDE Instagram silently dropped them, so the user got fewer posts than they asked for with
// nothing to say why. A drifting duplicate is the failure mode, so the test is about the duplicate.
//
// Run:  npx tsx tests/platform-allowlist.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { SOCIAL_PLATFORMS, PLATFORM_FORMATS, normalizePlatform } from '../src/config/platform-formats';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

console.log('\nPlatform allow-list — one list, no copies\n');

test('every publishable platform is in SOCIAL_PLATFORMS', () => {
    for (const p of ['instagram', 'facebook', 'linkedin', 'x', 'threads', 'youtube']) {
        assert.ok((SOCIAL_PLATFORMS as string[]).includes(p), `${p} missing from SOCIAL_PLATFORMS`);
    }
    assert.equal(SOCIAL_PLATFORMS.length, Object.keys(PLATFORM_FORMATS).length);
});

test('the composer derives its chips instead of listing them', () => {
    // _GP_PLATFORMS used to be a hand-written array of six {id,label} objects, which is how the
    // picker came to offer platforms the server refused. It is now built from the generated
    // constants, so the only thing left to assert is that nobody has written the list back.
    const html = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
    const decl = html.slice(html.indexOf('const _GP_PLATFORMS ='));
    const line = decl.slice(0, decl.indexOf('\n'));
    assert.ok(line.includes('PlatformConstants'), '_GP_PLATFORMS must come from the generated constants');
    assert.ok(!/id:\s*'instagram'/.test(line), '_GP_PLATFORMS is hand-written again');
});

test('neither drafting endpoint carries its own hand-written list any more', () => {
    for (const f of ['generate-post.ts', 'create-manual-post.ts']) {
        const src = readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8');
        assert.ok(src.includes('SOCIAL_PLATFORMS'), `${f} should use SOCIAL_PLATFORMS`);
        assert.ok(
            !/\[\s*'instagram',\s*'facebook',\s*'linkedin',\s*'x'\s*\]/.test(src),
            `${f} still hardcodes the stale four-platform list`,
        );
    }
});

test('the media-mandatory rule knows YouTube needs a video, not an image', () => {
    assert.equal(PLATFORM_FORMATS.youtube.mediaMandatory, true);
    assert.equal(PLATFORM_FORMATS.youtube.mediaKind, 'video');
    assert.equal(PLATFORM_FORMATS.instagram.mediaMandatory, true);
    assert.equal(PLATFORM_FORMATS.instagram.mediaKind, 'image');
    // Threads is text-first — requiring media would block a perfectly valid post.
    assert.equal(PLATFORM_FORMATS.threads.mediaMandatory, false);
});

test('no hand-written platform mirrors are left in workspace.html', () => {
    // Each of these WAS a hand-written copy, and each one drifted. They now come from
    // window.PlatformConstants; tests/client-constants-fresh.test.ts keeps that file in step with
    // the TypeScript. Re-introducing any of them re-introduces the bug class.
    const html = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
    const banned: Array<[string, RegExp]> = [
        ['a video-capable platform list', /_PCE_VIDEO_PLATFORMS\s*=/],
        ['a platform label map',          /_GPW_PLATFORM_LABELS\s*=\s*\{/],
        ['a char-limit map',              /_GPW_CHAR_LIMITS\s*=\s*\{/],
        ['a media-mandatory map',         /_needMedia\s*=\s*\{/],
    ];
    for (const [what, re] of banned) {
        assert.ok(!re.test(html), `workspace.html has re-introduced ${what}`);
    }
});

test('normalizePlatform resolves every offered platform to itself', () => {
    for (const p of SOCIAL_PLATFORMS) assert.equal(normalizePlatform(p), p);
    assert.equal(normalizePlatform('twitter'), 'x');
    assert.equal(normalizePlatform('nonsense'), null);
});

console.log(`\n${passed}/6 passed\n`);
