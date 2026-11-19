// tests/linkedin-page-rest-posts.test.ts
// Company Page posts go through LinkedIn's versioned Posts API (/rest/posts + /rest/images + /rest/videos);
// personal-profile posts stay on /v2/ugcPosts. fetch is stubbed — nothing reaches LinkedIn.
// Run:  npx tsx tests/linkedin-page-rest-posts.test.ts

import assert from 'node:assert';
import { LI_MULTI_IMAGE_MAX, LINKEDIN_REST_VERSION, linkedInPostBody, publishLinkedIn, publishLinkedInPagePost } from '../src/utils/social-publish';

let passed = 0;
let queue: Promise<void> = Promise.resolve();
function check(name: string, fn: () => void | Promise<void>): void {
    queue = queue.then(async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    });
}

type Call = { url: string; init?: RequestInit };
async function withFetch(responder: (url: string, init?: RequestInit) => Response, fn: (calls: Call[]) => Promise<void>) {
    const real = globalThis.fetch;
    const calls: Call[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return responder(String(url), init); }) as typeof fetch;
    try { await fn(calls); } finally { globalThis.fetch = real; }
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const hdr = (c: Call, k: string) => (c.init?.headers as Record<string, string> | undefined)?.[k];
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body));

const ORG = 'urn:li:organization:135063921';
const IMG = (n: number) => ({ url: `https://media.example/img${n}.png`, mimeType: 'image/png' });
const VID = { url: 'https://media.example/clip.mp4', mimeType: 'video/mp4' };
const POSTED = () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:7000000000000000001' } });

/** A LinkedIn stand-in: media bytes, image/video uploads, the post. */
function linkedin(over: Partial<Record<'post' | 'videoStatus' | 'imageInit', () => Response>> = {}) {
    let img = 0;
    return (url: string) => {
        if (url.startsWith('https://media.example/')) return new Response(new Uint8Array(url.endsWith('.mp4') ? 10 : 4), { status: 200 });
        if (url.includes('/rest/images?action=initializeUpload')) return over.imageInit?.() ?? json({ value: { uploadUrl: `https://up.example/img/${++img}`, image: `urn:li:image:I${img}` } });
        if (url.startsWith('https://up.example/img/')) return new Response(null, { status: 201 });
        if (url.includes('/rest/videos?action=initializeUpload')) return json({ value: { video: 'urn:li:video:V1', uploadToken: 'tok-1', uploadInstructions: [
            { uploadUrl: 'https://up.example/vid/1', firstByte: 0, lastByte: 5 }, { uploadUrl: 'https://up.example/vid/2', firstByte: 6, lastByte: 9 }] } });
        if (url === 'https://up.example/vid/1') return new Response(null, { status: 200, headers: { etag: '"e1"' } });
        if (url === 'https://up.example/vid/2') return new Response(null, { status: 200, headers: { etag: '"e2"' } });
        if (url.includes('/rest/videos?action=finalizeUpload')) return json({}, 200);
        if (url.startsWith('https://api.linkedin.com/rest/videos/')) return over.videoStatus?.() ?? json({ status: 'AVAILABLE' });
        if (url === 'https://api.linkedin.com/rest/posts') return over.post?.() ?? POSTED();
        return json({ message: `unexpected ${url}` }, 599);
    };
}

check('the post body: the Page as author, escaped little text, public main feed, published', () => {
    const b = linkedInPostBody(ORG, 'Top 3 (ranked) #tips');
    assert.equal(b.author, ORG);
    assert.equal(b.commentary, 'Top 3 \\(ranked\\) {hashtag|\\#|tips}');
    assert.equal(b.visibility, 'PUBLIC');
    assert.deepEqual(b.distribution, { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] });
    assert.equal(b.lifecycleState, 'PUBLISHED');
    assert.ok(!('content' in b), 'no content key on a text post');
});

check('a Page text post: ONE call to /rest/posts with the version header, never ugcPosts', async () => {
    await withFetch(linkedin(), async (calls) => {
        const r = await publishLinkedIn('Hello', 'tok', ORG, null);
        assert.deepEqual(r, { ok: true, id: 'urn:li:share:7000000000000000001' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.linkedin.com/rest/posts');
        assert.equal(hdr(calls[0], 'Linkedin-Version'), LINKEDIN_REST_VERSION);
        assert.equal(hdr(calls[0], 'X-Restli-Protocol-Version'), '2.0.0');
        assert.equal(bodyOf(calls[0]).author, ORG);
    });
});

check('a personal-profile post still goes to /v2/ugcPosts', async () => {
    await withFetch(() => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }), async (calls) => {
        const r = await publishLinkedIn('Hello', 'tok', 'urn:li:person:abc', null);
        assert.equal(r.ok, true);
        assert.equal(calls[0].url, 'https://api.linkedin.com/v2/ugcPosts');
    });
});

check('one picture: initializeUpload as the Page → PUT with the token → content.media.id', async () => {
    await withFetch(linkedin(), async (calls) => {
        const r = await publishLinkedInPagePost('Pic', 'tok', ORG, IMG(1));
        assert.equal(r.ok, true);
        const init = calls.find((c) => c.url.includes('/rest/images?action=initializeUpload'))!;
        assert.deepEqual(bodyOf(init), { initializeUploadRequest: { owner: ORG } });
        const put = calls.find((c) => c.url.startsWith('https://up.example/img/'))!;
        assert.equal(put.init?.method, 'PUT');
        assert.equal(hdr(put, 'Authorization'), 'Bearer tok');
        const post = calls.at(-1)!;
        assert.deepEqual(bodyOf(post).content, { media: { id: 'urn:li:image:I1' } });
    });
});

check('several pictures: each uploaded, in order, as content.multiImage.images', async () => {
    await withFetch(linkedin(), async (calls) => {
        const r = await publishLinkedInPagePost('Pics', 'tok', ORG, [IMG(1), IMG(2), IMG(3)]);
        assert.equal(r.ok, true);
        assert.deepEqual(bodyOf(calls.at(-1)!).content, { multiImage: { images: [{ id: 'urn:li:image:I1' }, { id: 'urn:li:image:I2' }, { id: 'urn:li:image:I3' }] } });
    });
    const tooMany = Array.from({ length: LI_MULTI_IMAGE_MAX + 1 }, (_, i) => IMG(i));
    await withFetch(linkedin(), async (calls) => {
        const r = await publishLinkedInPagePost('x', 'tok', ORG, tooMany);
        assert.equal(r.ok, false);
        assert.equal(calls.length, 0, 'refused before uploading anything');
    });
});

check('a video: parts PUT without the token, ETags into finalizeUpload, posted once AVAILABLE', async () => {
    await withFetch(linkedin(), async (calls) => {
        const r = await publishLinkedInPagePost('Clip', 'tok', ORG, VID, { pollMs: 0 });
        assert.equal(r.ok, true);
        const init = calls.find((c) => c.url.includes('/rest/videos?action=initializeUpload'))!;
        assert.deepEqual(bodyOf(init), { initializeUploadRequest: { owner: ORG, fileSizeBytes: 10, uploadCaptions: false, uploadThumbnail: false } });
        const parts = calls.filter((c) => c.url.startsWith('https://up.example/vid/'));
        assert.equal(parts.length, 2);
        for (const p of parts) { assert.equal(p.init?.method, 'PUT'); assert.equal(hdr(p, 'Authorization'), undefined, 'pre-signed: no token sent'); }
        assert.equal((parts[0].init?.body as Buffer).length, 6, 'bytes 0–5');
        assert.equal((parts[1].init?.body as Buffer).length, 4, 'bytes 6–9');
        const fin = calls.find((c) => c.url.includes('finalizeUpload'))!;
        assert.deepEqual(bodyOf(fin), { finalizeUploadRequest: { video: 'urn:li:video:V1', uploadToken: 'tok-1', uploadedPartIds: ['"e1"', '"e2"'] } });
        assert.deepEqual(bodyOf(calls.at(-1)!).content, { media: { id: 'urn:li:video:V1' } });
    });
});

check('a video still processing: posted anyway; a refusal then is a retry (503), not a permanent failure', async () => {
    await withFetch(linkedin({ videoStatus: () => json({ status: 'PROCESSING' }), post: () => json({ message: 'media not ready' }, 422) }), async (calls) => {
        const r = await publishLinkedInPagePost('Clip', 'tok', ORG, VID, { pollMs: 0 });
        assert.equal(r.ok, false);
        assert.equal((r as { status: number }).status, 503);
        assert.match((r as { error: string }).error, /media not ready/, "LinkedIn's own words are kept");
        assert.ok(calls.some((c) => c.url === 'https://api.linkedin.com/rest/posts'), 'the post was tried');
    });
    await withFetch(linkedin({ videoStatus: () => json({ status: 'PROCESSING' }), post: () => json({ message: 'Not enough permissions to post as this organization' }, 403) }), async () => {
        const r = await publishLinkedInPagePost('Clip', 'tok', ORG, VID, { pollMs: 0 });
        assert.equal((r as { status: number }).status, 403, 'a permission refusal is not dressed up as "still processing"');
        assert.match((r as { error: string }).error, /Not enough permissions/);
    });
    await withFetch(linkedin({ videoStatus: () => json({ status: 'PROCESSING_FAILED', processingFailureReason: 'BAD_CODEC' }) }), async (calls) => {
        const r = await publishLinkedInPagePost('Clip', 'tok', ORG, VID, { pollMs: 0 });
        assert.equal(r.ok, false);
        assert.match((r as { error: string }).error, /BAD_CODEC/);
        assert.ok(!calls.some((c) => c.url === 'https://api.linkedin.com/rest/posts'), 'never posted');
    });
});

check('an upload refusal never becomes a text-only post', async () => {
    await withFetch(linkedin({ imageInit: () => json({ message: 'Not enough permissions' }, 403) }), async (calls) => {
        const r = await publishLinkedInPagePost('Pic', 'tok', ORG, IMG(1));
        assert.equal(r.ok, false);
        assert.equal((r as { status: number }).status, 403);
        assert.ok(!calls.some((c) => c.url === 'https://api.linkedin.com/rest/posts'));
    });
});

check('a video mixed with pictures is refused before any upload', async () => {
    await withFetch(linkedin(), async (calls) => {
        const r = await publishLinkedInPagePost('x', 'tok', ORG, [IMG(1), VID]);
        assert.equal(r.ok, false);
        assert.equal(calls.length, 0);
    });
});

queue.then(() => console.log(`\n${passed} passed`));
