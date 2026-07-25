// tests/video-drivers.test.ts
//
// Video publishing on the four platforms that previously had none: Facebook, LinkedIn, X, Threads.
//
// Until now only Instagram (REELS) and YouTube could send a video, and the others silently dropped
// it — see media-never-dropped.test.ts for that half. These tests cover the other half: that the
// request each driver builds is the one the platform's API documents, and that the kind of media is
// carried all the way through rather than assumed to be an image.
//
// Each API has a DIFFERENT shape for the same idea, and getting any of them subtly wrong produces a
// rejected post rather than a crash, so the request shape itself is the thing under test:
//   Facebook  — a separate /videos edge taking a remote file_url
//   LinkedIn  — the same registerUpload dance with a different RECIPE, and a matching category
//   X         — chunked INIT → APPEND → FINALIZE, then a wait for transcoding
//   Threads   — a VIDEO container that must be polled to FINISHED before it can be published
//
// NOT COVERED: the live APIs. These prove the requests we send, not that the platforms accept them —
// verify each with one real post before relying on it. What makes that safe is that a wrong shape
// now FAILS the post loudly (mediaDropped) rather than publishing a bare caption.
//
// Run:  npx tsx tests/video-drivers.test.ts

import assert from 'node:assert';
import { publishFacebook, publishLinkedIn, publishThreads, publishX, isVideoMedia } from '../src/utils/social-publish';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const VIDEO = { url: 'https://r2.example.com/presigned/clip.mp4', mimeType: 'video/mp4' };
const IMAGE = { url: 'https://r2.example.com/presigned/pic.jpg', mimeType: 'image/jpeg' };
const realFetch = globalThis.fetch;

interface Call { url: string; body: unknown; }

function withFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        let body: unknown = init?.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* form-encoded */ } }
        calls.push({ url, body });
        return handler(url, init);
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Bytes for the chunked-upload tests — big enough to force more than one segment. */
function fakeVideoResponse(size: number) {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31) & 0xff;
    return new Response(buf, { status: 200 });
}

async function main() {
    console.log('\nMedia kind is derived from the mime type\n');

    await check('isVideoMedia recognises video and nothing else', () => {
        assert.equal(isVideoMedia(VIDEO), true);
        assert.equal(isVideoMedia({ mimeType: 'video/quicktime' }), true);
        assert.equal(isVideoMedia(IMAGE), false);
        assert.equal(isVideoMedia(null), false);
        assert.equal(isVideoMedia(undefined), false);
        // Not a video just because the word appears somewhere in the type.
        assert.equal(isVideoMedia({ mimeType: 'image/x-video-thumb' }), false);
    });

    console.log('\nFacebook\n');

    await check('a video goes to /videos with file_url, not /photos', async () => {
        const f = withFetch(() => json({ id: 'fb-vid-1' }));
        try {
            const res = await publishFacebook('page1', 'tok', 'Watch this', VIDEO);
            assert.equal(res.ok, true);
            const call = f.calls[0];
            assert.match(call.url, /\/page1\/videos$/, 'must use the /videos edge');
            assert.equal((call.body as any).file_url, VIDEO.url);
            assert.equal((call.body as any).description, 'Watch this', 'video uses description, not caption');
        } finally { f.restore(); }
    });

    await check('an image still goes to /photos with url + caption', async () => {
        const f = withFetch(() => json({ id: 'fb-img-1' }));
        try {
            await publishFacebook('page1', 'tok', 'Look', IMAGE);
            assert.match(f.calls[0].url, /\/page1\/photos$/);
            assert.equal((f.calls[0].body as any).caption, 'Look');
        } finally { f.restore(); }
    });

    await check('text with no media still goes to /feed', async () => {
        const f = withFetch(() => json({ id: 'fb-txt-1' }));
        try {
            await publishFacebook('page1', 'tok', 'Just words', null);
            assert.match(f.calls[0].url, /\/page1\/feed$/);
        } finally { f.restore(); }
    });

    console.log('\nLinkedIn\n');

    await check('a video registers under the feedshare-video recipe and posts as VIDEO', async () => {
        const f = withFetch((url) => {
            if (url.includes('registerUpload')) {
                return json({ value: {
                    asset: 'urn:li:digitalmediaAsset:V1',
                    uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.linkedin.example/v1' } },
                } });
            }
            if (url.startsWith('https://upload.linkedin.example')) return new Response('', { status: 201 });
            return json({ id: 'urn:li:share:99' });
        });
        try {
            const res = await publishLinkedIn('Watch', 'tok', 'urn:li:person:abc', VIDEO);
            assert.equal(res.ok, true);
            const reg = f.calls.find(c => c.url.includes('registerUpload'))!;
            assert.deepEqual(
                (reg.body as any).registerUploadRequest.recipes,
                ['urn:li:digitalmediaRecipe:feedshare-video'],
                'a video must not be registered with the image recipe',
            );
            const post = f.calls.find(c => c.url.includes('ugcPosts'))!;
            const content = (post.body as any).specificContent['com.linkedin.ugc.ShareContent'];
            assert.equal(content.shareMediaCategory, 'VIDEO', 'the category must match what was uploaded');
        } finally { f.restore(); }
    });

    await check('an image still uses the image recipe and IMAGE category', async () => {
        const f = withFetch((url) => {
            if (url.includes('registerUpload')) {
                return json({ value: {
                    asset: 'urn:li:digitalmediaAsset:I1',
                    uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.linkedin.example/i1' } },
                } });
            }
            if (url.startsWith('https://upload.linkedin.example')) return new Response('', { status: 201 });
            return json({ id: 'urn:li:share:1' });
        });
        try {
            await publishLinkedIn('Look', 'tok', 'urn:li:person:abc', IMAGE);
            const reg = f.calls.find(c => c.url.includes('registerUpload'))!;
            assert.deepEqual((reg.body as any).registerUploadRequest.recipes, ['urn:li:digitalmediaRecipe:feedshare-image']);
            const post = f.calls.find(c => c.url.includes('ugcPosts'))!;
            assert.equal((post.body as any).specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory, 'IMAGE');
        } finally { f.restore(); }
    });

    console.log('\nThreads\n');

    await check('a video creates a VIDEO container with video_url, and waits for FINISHED', async () => {
        let statusChecks = 0;
        const f = withFetch((url) => {
            if (url.includes('/threads_publish')) return json({ id: 'th-published' });
            if (url.includes('fields=status')) {
                statusChecks++;
                // IN_PROGRESS first — publishing before FINISHED is rejected by Threads.
                return json({ status: statusChecks < 2 ? 'IN_PROGRESS' : 'FINISHED' });
            }
            return json({ id: 'container-1' });
        });
        try {
            const res = await publishThreads('Watch', 'tok', 'user1', VIDEO);
            assert.equal(res.ok, true);
            const create = f.calls[0];
            const params = new URLSearchParams(String((create.body as any) ?? ''));
            assert.equal(params.get('media_type'), 'VIDEO');
            assert.equal(params.get('video_url'), VIDEO.url);
            assert.ok(statusChecks >= 2, 'must poll until the container is FINISHED');
            // And only THEN publish.
            const publishIdx = f.calls.findIndex(c => c.url.includes('threads_publish'));
            const lastStatusIdx = f.calls.map(c => c.url).lastIndexOf(f.calls.filter(c => c.url.includes('fields=status')).at(-1)!.url);
            assert.ok(publishIdx > lastStatusIdx, 'published before the container was ready');
        } finally { f.restore(); }
    });

    await check('a container that ERRORs fails with the platform’s own message', async () => {
        const f = withFetch((url) => {
            if (url.includes('fields=status')) return json({ status: 'ERROR', error_message: 'Unsupported codec' });
            return json({ id: 'container-2' });
        });
        try {
            const res = await publishThreads('Watch', 'tok', 'user1', VIDEO) as { ok: boolean; error?: string };
            assert.equal(res.ok, false);
            assert.match(res.error ?? '', /Unsupported codec/);
        } finally { f.restore(); }
    });

    await check('an image container is published immediately, with no polling', async () => {
        const f = withFetch((url) => {
            if (url.includes('fields=status')) throw new Error('an image must not be polled');
            if (url.includes('/threads_publish')) return json({ id: 'th-img' });
            return json({ id: 'container-3' });
        });
        try {
            const res = await publishThreads('Look', 'tok', 'user1', IMAGE);
            assert.equal(res.ok, true);
            const params = new URLSearchParams(String((f.calls[0].body as any) ?? ''));
            assert.equal(params.get('media_type'), 'IMAGE');
        } finally { f.restore(); }
    });

    console.log('\nX\n');

    await check('a video is uploaded in chunks: initialize → append × n → finalize', async () => {
        const SIZE = 12 * 1024 * 1024;   // 12 MB → 3 segments at the 5 MB chunk size
        const f = withFetch((url) => {
            if (url === VIDEO.url) return fakeVideoResponse(SIZE);
            if (url.includes('/media/upload/initialize')) return json({ data: { id: 'media-9' } });
            if (url.includes('/append')) return json({});
            if (url.includes('/finalize')) return json({ data: { id: 'media-9' } });
            return json({ data: { id: 'tweet-9' } });
        });
        try {
            const res = await publishX('Watch', 'tok', VIDEO);
            assert.equal(res.ok, true);
            const appends = f.calls.filter(c => c.url.includes('/append'));
            assert.equal(appends.length, 3, `expected 3 chunks for 12 MB, got ${appends.length}`);
            assert.ok(f.calls.some(c => c.url.includes('/finalize')), 'must finalize');
            const tweet = f.calls.find(c => c.url.endsWith('/2/tweets'))!;
            assert.deepEqual((tweet.body as any).media.media_ids, ['media-9'], 'the tweet must carry the media id');
        } finally { f.restore(); }
    });

    await check('a video still transcoding is waited for, then tweeted', async () => {
        let polls = 0;
        const f = withFetch((url) => {
            if (url === VIDEO.url) return fakeVideoResponse(1024);
            if (url.includes('/media/upload/initialize')) return json({ data: { id: 'media-slow' } });
            if (url.includes('/append')) return json({});
            if (url.includes('/finalize')) return json({ data: { id: 'media-slow', processing_info: { state: 'in_progress', check_after_secs: 0 } } });
            if (url.includes('command=STATUS')) {
                polls++;
                return json({ data: { processing_info: { state: polls < 2 ? 'in_progress' : 'succeeded' } } });
            }
            return json({ data: { id: 'tweet-slow' } });
        });
        try {
            const res = await publishX('Watch', 'tok', VIDEO);
            assert.equal(res.ok, true, 'a video that needed transcoding should still post');
            assert.ok(polls >= 2, 'must poll STATUS until processing succeeds');
        } finally { f.restore(); }
    });

    await check('a rejected video fails the post and reports X’s reason', async () => {
        const f = withFetch((url) => {
            if (url === VIDEO.url) return fakeVideoResponse(1024);
            if (url.includes('/media/upload/initialize')) return json({ detail: 'Invalid media_category' }, 400);
            return json({ data: { id: 'tweet-x' } });
        });
        try {
            const res = await publishX('Watch', 'tok', VIDEO) as { ok: boolean; error?: string };
            assert.equal(res.ok, false);
            assert.match(res.error ?? '', /Invalid media_category/, 'the platform’s reason must reach the queue');
            assert.ok(!f.calls.some(c => c.url.endsWith('/2/tweets')), 'must not tweet without the video');
        } finally { f.restore(); }
    });

    console.log(`\n${passed}/12 passed\n`);
}

main();
