// tests/carousel-drivers.test.ts
//
// Multi-attachment posts — carousels — across the drivers that can send them.
//
// Every publisher used to send exactly ONE attachment, which is why every carousel format in
// src/config/post-formats.ts was marked 'planned'. Each platform expresses "several pictures, one
// post" completely differently, and each has a trap that produces a WRONG post rather than an error:
//
//   Facebook — photos must be uploaded `published: false` first. Forget that and you get N stray
//              photo posts on the page alongside the real one, and no way to undo it.
//   Threads  — child containers (is_carousel_item) then a CAROUSEL parent carrying the text.
//   LinkedIn — one media[] entry per slide; a single entry silently posts just the first picture.
//   X        — up to 4 images, or one video, never mixed.
//
// Ordering is part of the payload, not an implementation detail: a carousel whose slides arrive in a
// different order is a different post, so the sequence is asserted everywhere.
//
// NOT COVERED: the live APIs. These prove the requests we build.
//
// Run:  npx tsx tests/carousel-drivers.test.ts

import assert from 'node:assert';
import { publishFacebook, publishLinkedIn, publishThreads, publishX, resolvePostMediaList } from '../src/utils/social-publish';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const slide = (n: number) => ({ url: `https://r2.example.com/slide-${n}.jpg`, mimeType: 'image/jpeg' });
const VIDEO = { url: 'https://r2.example.com/clip.mp4', mimeType: 'video/mp4' };
const realFetch = globalThis.fetch;

interface Call { url: string; body: any; }
function withFetch(handler: (url: string, init?: RequestInit) => Response) {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        let body: any = init?.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* form-encoded */ } }
        calls.push({ url, body });
        return handler(url, init);
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function main() {
    console.log('\nFacebook — multi-photo\n');

    await check('each photo is uploaded UNPUBLISHED, then attached to one feed post', async () => {
        let photo = 0;
        const f = withFetch((url) => {
            if (url.includes('/photos')) return json({ id: `ph-${++photo}` });
            return json({ id: 'post-1' });
        });
        try {
            const res = await publishFacebook('page1', 'tok', 'Three slides', [slide(1), slide(2), slide(3)]);
            assert.equal(res.ok, true);
            const uploads = f.calls.filter(c => c.url.includes('/photos'));
            assert.equal(uploads.length, 3, 'one upload per slide');
            for (const u of uploads) {
                assert.equal(u.body.published, false, 'an unpublished upload is what stops stray posts appearing on the page');
            }
            // Order is the carousel.
            assert.deepEqual(uploads.map(u => u.body.url), [slide(1).url, slide(2).url, slide(3).url]);
            const feed = f.calls.find(c => c.url.includes('/feed'))!;
            assert.deepEqual(feed.body.attached_media, [{ media_fbid: 'ph-1' }, { media_fbid: 'ph-2' }, { media_fbid: 'ph-3' }]);
            assert.equal(feed.body.message, 'Three slides');
        } finally { f.restore(); }
    });

    await check('a failed slide upload fails the post — no half-built carousel', async () => {
        let photo = 0;
        const f = withFetch((url) => {
            if (url.includes('/photos')) return ++photo === 2 ? json({ error: { message: 'Bad image' } }, 400) : json({ id: `ph-${photo}` });
            return json({ id: 'post-1' });
        });
        try {
            const res = await publishFacebook('page1', 'tok', 'x', [slide(1), slide(2), slide(3)]) as { ok: boolean; error?: string };
            assert.equal(res.ok, false);
            assert.match(res.error ?? '', /Bad image/);
            assert.ok(!f.calls.some(c => c.url.includes('/feed')), 'must not publish a carousel missing a slide');
        } finally { f.restore(); }
    });

    await check('a single photo still uses the ordinary published /photos path', async () => {
        const f = withFetch(() => json({ id: 'p1' }));
        try {
            await publishFacebook('page1', 'tok', 'One', [slide(1)]);
            const call = f.calls[0];
            assert.match(call.url, /\/photos$/);
            assert.equal(call.body.published, undefined, 'a lone photo is published directly, not staged');
            assert.equal(call.body.caption, 'One');
        } finally { f.restore(); }
    });

    console.log('\nThreads — carousel\n');

    await check('children are created with is_carousel_item, then a CAROUSEL parent carries the text', async () => {
        let child = 0;
        const f = withFetch((url) => {
            if (url.includes('/threads_publish')) return json({ id: 'th-live' });
            if (url.includes('/threads')) return json({ id: `c-${++child}` });
            return json({});
        });
        try {
            const res = await publishThreads('Swipe →', 'tok', 'user1', [slide(1), slide(2)]);
            assert.equal(res.ok, true);
            const posts = f.calls.filter(c => c.url.endsWith('/threads'));
            const children = posts.slice(0, 2).map(c => new URLSearchParams(String(c.body)));
            for (const p of children) {
                assert.equal(p.get('is_carousel_item'), 'true');
                assert.equal(p.get('text'), null, 'a child must not carry the caption — the parent does');
            }
            assert.deepEqual(children.map(p => p.get('image_url')), [slide(1).url, slide(2).url]);
            const parent = new URLSearchParams(String(posts[2].body));
            assert.equal(parent.get('media_type'), 'CAROUSEL');
            assert.equal(parent.get('children'), 'c-1,c-2');
            assert.equal(parent.get('text'), 'Swipe →');
        } finally { f.restore(); }
    });

    console.log('\nLinkedIn — multi-image\n');

    await check('every slide is registered and listed in media[], in order', async () => {
        let n = 0;
        const f = withFetch((url) => {
            if (url.includes('registerUpload')) {
                const i = ++n;
                return json({ value: {
                    asset: `urn:li:asset:${i}`,
                    uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: `https://upload.li/${i}` } },
                } });
            }
            if (url.startsWith('https://upload.li/')) return new Response('', { status: 201 });
            return json({ id: 'urn:li:share:1' });
        });
        try {
            const res = await publishLinkedIn('Deck', 'tok', 'urn:li:person:abc', [slide(1), slide(2), slide(3)]);
            assert.equal(res.ok, true);
            assert.equal(f.calls.filter(c => c.url.includes('registerUpload')).length, 3);
            const post = f.calls.find(c => c.url.includes('ugcPosts'))!;
            const content = post.body.specificContent['com.linkedin.ugc.ShareContent'];
            assert.deepEqual(content.media.map((m: any) => m.media), ['urn:li:asset:1', 'urn:li:asset:2', 'urn:li:asset:3']);
            assert.equal(content.shareMediaCategory, 'IMAGE');
        } finally { f.restore(); }
    });

    await check('a video cannot be one slide of a multi-image LinkedIn post', async () => {
        const f = withFetch(() => json({}));
        try {
            const res = await publishLinkedIn('x', 'tok', 'urn:li:person:abc', [slide(1), VIDEO]) as { ok: boolean; error?: string };
            assert.equal(res.ok, false);
            assert.match(res.error ?? '', /cannot include a video/i);
            assert.equal(f.calls.length, 0, 'refuse before spending any uploads');
        } finally { f.restore(); }
    });

    console.log('\nX — up to four images\n');

    await check('all four media ids reach the tweet, in order', async () => {
        let n = 0;
        const f = withFetch((url) => {
            if (url.includes('/media/upload')) return json({ data: { id: `m${++n}` } });
            return json({ data: { id: 'tweet-1' } });
        });
        try {
            const res = await publishX('Four', 'tok', [slide(1), slide(2), slide(3), slide(4)]);
            assert.equal(res.ok, true);
            const tweet = f.calls.find(c => c.url.endsWith('/2/tweets'))!;
            assert.deepEqual(tweet.body.media.media_ids, ['m1', 'm2', 'm3', 'm4']);
        } finally { f.restore(); }
    });

    await check('a fifth image is dropped rather than rejected by X', async () => {
        let n = 0;
        const f = withFetch((url) => {
            if (url.includes('/media/upload')) return json({ data: { id: `m${++n}` } });
            return json({ data: { id: 'tweet-1' } });
        });
        try {
            await publishX('Five', 'tok', [slide(1), slide(2), slide(3), slide(4), slide(5)]);
            assert.equal(f.calls.filter(c => c.url.includes('/media/upload')).length, 4, 'never upload past the platform cap');
        } finally { f.restore(); }
    });

    await check('images mixed with a video is refused before any upload', async () => {
        const f = withFetch(() => json({}));
        try {
            const res = await publishX('x', 'tok', [slide(1), VIDEO]) as { ok: boolean; error?: string };
            assert.equal(res.ok, false);
            assert.match(res.error ?? '', /one video or up to four images/i);
            assert.equal(f.calls.length, 0);
        } finally { f.restore(); }
    });

    console.log('\nSingle-media callers are unaffected\n');

    await check('passing one attachment (not an array) still works everywhere', async () => {
        const f = withFetch((url) => {
            if (url.includes('registerUpload')) {
                return json({ value: { asset: 'urn:li:asset:1', uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.li/1' } } } });
            }
            if (url.startsWith('https://upload.li/')) return new Response('', { status: 201 });
            if (url.includes('/media/upload')) return json({ data: { id: 'm1' } });
            if (url.includes('/threads_publish')) return json({ id: 'th' });
            return json({ id: 'ok', data: { id: 'ok' } });
        });
        try {
            assert.equal((await publishFacebook('p', 't', 'x', slide(1))).ok, true);
            assert.equal((await publishLinkedIn('x', 't', 'urn:li:person:a', slide(1))).ok, true);
            assert.equal((await publishX('x', 't', slide(1))).ok, true);
            assert.equal((await publishThreads('x', 't', 'u', slide(1))).ok, true);
        } finally { f.restore(); }
    });

    console.log('\nSlide order is part of the payload\n');

    await check('order follows the requested ids, not whatever the database returns', async () => {
        // The rows come back in a different order from the ids — which is exactly what an
        // unordered `inArray` query does. A carousel whose slides arrive in a different order is a
        // different post, and this is the only thing standing between that and a query planner.
        const rows = [
            { id: 30, assetType: 'image', mimeType: 'image/png',  storageKey: null, externalUrl: 'https://x/c.png' },
            { id: 10, assetType: 'image', mimeType: 'image/jpeg', storageKey: null, externalUrl: 'https://x/a.jpg' },
            { id: 20, assetType: 'video', mimeType: 'video/mp4',  storageKey: null, externalUrl: 'https://x/b.mp4' },
            { id: 40, assetType: 'audio', mimeType: 'audio/mp3',  storageKey: null, externalUrl: 'https://x/d.mp3' },
        ];
        const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
        const out = await resolvePostMediaList(db as never, [10, 20, 30, 40]);
        assert.deepEqual(out.map(o => o.assetId), [10, 20, 30], 'slide order must follow the id array');
        assert.deepEqual(out.map(o => o.kind), ['image', 'video', 'image']);
        // A voice note is attached to a post but is not a slide.
        assert.ok(!out.some(o => o.assetId === 40), 'audio must never become a carousel slide');
    });

    await check('empty, null and single-item inputs behave', async () => {
        const db = { select: () => ({ from: () => ({ where: async () => [] }) }) };
        assert.deepEqual(await resolvePostMediaList(db as never, []), []);
        assert.deepEqual(await resolvePostMediaList(db as never, null), []);
        assert.deepEqual(await resolvePostMediaList(db as never, 'nonsense'), []);
    });

    console.log(`\n${passed}/12 passed\n`);
}

main();
