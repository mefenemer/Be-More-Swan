// tests/rendered-video-publishability.test.ts
//
// What happens to a post AFTER a render turns it into a video.
//
// The bug this file exists to stop coming back: attachRenderedVideo swapped the post's media for an
// mp4 but left post_format saying 'image'. Nothing complained, because every check downstream reads
// a different field:
//   • publish-instagram.ts picks IMAGE vs REELS from post_format alone, so it sent
//     media_type: 'IMAGE' pointing at an mp4 — a rejection the reviewer never saw coming.
//   • resolvePostImage only returns assets whose type is 'image', so Facebook/X/LinkedIn/Threads
//     got null and published the caption ALONE, dropping the media with no error recorded.
//
// Sound is what made this reachable: audio on a photo is rendered in at approval, so an ordinary
// picture post silently became a video. Both halves are covered here — the format must follow the
// media, and approval must refuse platforms whose driver cannot send a video at all.
//
// Run:  npx tsx tests/rendered-video-publishability.test.ts

import assert from 'node:assert';
import { attachRenderedVideo } from '../src/lib/post-render';
import { PLATFORM_FORMATS, platformFormat, SOCIAL_PLATFORMS } from '../src/config/platform-formats';
import { needsVideoRender } from '../src/lib/audio-overlays';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

/**
 * The smallest fake that satisfies the drizzle chains attachRenderedVideo uses. It records the
 * update payload, which is the thing under test — not the SQL.
 */
function fakeDb(currentPostFormat: string | null) {
    const updates: Record<string, unknown>[] = [];
    const chain = <T>(v: T) => v;
    return {
        updates,
        delete: () => ({ where: async () => chain(undefined) }),
        insert: () => ({ values: () => ({ onConflictDoNothing: async () => chain(undefined) }) }),
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => [{ postFormat: currentPostFormat }] }),
            }),
        }),
        update: () => ({
            set: (payload: Record<string, unknown>) => {
                updates.push(payload);
                return { where: async () => chain(undefined) };
            },
        }),
    };
}

async function main() {
    console.log('\nA rendered post has to say it is a video\n');

    await test('a photo post that gained sound becomes post_format "video"', async () => {
    const db = fakeDb('image');
    await attachRenderedVideo(db as never, 42, 99);
    const set = db.updates.at(-1)!;
    assert.equal(set.postFormat, 'video', 'post_format must follow the media, or Instagram sends media_type IMAGE for an mp4');
    assert.deepEqual(set.contentAssetIds, [99]);
    });

    await test('a text post that gained sound becomes a video too', async () => {
    const db = fakeDb('text');
    await attachRenderedVideo(db as never, 42, 99);
    assert.equal(db.updates.at(-1)!.postFormat, 'video');
    });

    await test('a Reel is left as a Reel, not flattened to "video"', async () => {
    // 'reel' is the more specific truth and publish-instagram already treats it as video.
    for (const f of ['reel', 'video', 'short', 'REEL']) {
    const db = fakeDb(f);
    await attachRenderedVideo(db as never, 42, 99);
    assert.ok(!('postFormat' in db.updates.at(-1)!), `${f} should be left alone, got a postFormat write`);
    }
    });

    await test('a post with no format recorded still ends up declared a video', async () => {
    const db = fakeDb(null);
    await attachRenderedVideo(db as never, 42, 99);
    assert.equal(db.updates.at(-1)!.postFormat, 'video');
    });

    console.log('\n…and only where a video can actually be sent\n');

    await test('every platform claiming canPublishVideo has a driver that can', async () => {
    // The flag is only as good as the code behind it. Each string below is the distinctive part of
    // that platform's video path — if a driver is removed while the flag stays true, posts go back
    // to publishing as bare captions, which is exactly what this file exists to prevent.
    const { readFileSync } = await import('node:fs');
    const drivers = readFileSync(new URL('../src/utils/social-publish.ts', import.meta.url), 'utf8')
        + readFileSync(new URL('../netlify/functions/publish-instagram.ts', import.meta.url), 'utf8');
    const evidence: Record<string, string> = {
        instagram: "media_type = 'REELS'",
        facebook:  '/videos',
        linkedin:  'feedshare-video',
        x:         '/media/upload/initialize',
        threads:   "'VIDEO' :",
        youtube:   'publishYouTubeResumable',
    };
    for (const p of SOCIAL_PLATFORMS) {
    if (!PLATFORM_FORMATS[p].canPublishVideo) continue;
    assert.ok(drivers.includes(evidence[p]), `${p} claims canPublishVideo but its video path is missing`);
    }
    });

    await test('sound on a photo is what turns an image post into a video', async () => {
    // The exact combination approve-post now refuses on a video-less platform.
    assert.equal(needsVideoRender({ hasVideo: false, textOverlays: 0, audioOverlays: 1 }), true);
    // Text alone burns into whatever is already there — it never changes the media kind.
    assert.equal(needsVideoRender({ hasVideo: false, textOverlays: 3, audioOverlays: 0 }), false);
    });

    await test('the refusal names a platform the user can actually use', async () => {
    // The error text points at Instagram/YouTube; both must really be able to take it.
    const alternatives = (['instagram', 'youtube'] as const).filter(p => platformFormat(p).canPublishVideo);
    assert.deepEqual(alternatives, ['instagram', 'youtube']);
    });

    console.log(`\n${passed}/7 passed\n`);
}

main();
