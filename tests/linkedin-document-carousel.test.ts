// tests/linkedin-document-carousel.test.ts
// LinkedIn document carousels, Phase 1 (docs/linkedin-document-carousel-plan.md). BEHAVIOUR checks:
// the format is live and is LinkedIn's carousel; the slides become ONE PDF, a page per slide, in order;
// caption text is escaped for LinkedIn's Posts API; the publisher calls initializeUpload → PUT → poll →
// /rest/posts with the pinned version, and a failed upload never turns into a text-only post.
//
// Run:  npx tsx tests/linkedin-document-carousel.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { postFormatSpec } from '../src/config/post-formats';
import { routeAsset } from '../src/utils/format-router';
import { carouselFormatFor, linkedInDocumentTitle, CAROUSEL_MAX_SLIDES } from '../src/utils/top-lists';
import {
    littleText, slideImageKind, slidesPdf, isLinkedInDocument, publishLinkedInDocument, LINKEDIN_REST_VERSION,
    isPdfSlideMime, nonPdfSlideMime, LI_DOCUMENT_POLL_MS, LI_DOCUMENT_MAX_POLLS,
} from '../src/utils/social-publish';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// Real 1×1 PNG and JPEG bytes (the JPEG made from the PNG with macOS sips).
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG_1x1 = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+mKKKK/Kz/QA/9k=', 'base64');
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1');

(async () => {
    await check('li_document is live: 2–20 image slides at 4:5 or 1:1', () => {
        const spec = postFormatSpec('li_document')!;
        assert.equal(spec.availability, 'live');
        assert.equal(spec.media, 'image');
        assert.equal(spec.minItems, 2);
        assert.equal(spec.maxItems, CAROUSEL_MAX_SLIDES);
        assert.deepEqual(spec.aspectRatios, ['4:5', '1:1']);
    });

    await check('LinkedIn\'s carousel format is the document; Facebook and X still have none', () => {
        assert.equal(carouselFormatFor('linkedin'), 'li_document');
        assert.equal(carouselFormatFor('LinkedIn'), 'li_document');
        assert.equal(carouselFormatFor('facebook'), null);
        assert.equal(carouselFormatFor('x'), null);
        assert.equal(isLinkedInDocument('li_document'), true);
        assert.equal(isLinkedInDocument('li_feed'), false);
        assert.equal(isLinkedInDocument(null), false);
    });

    await check('slides → one PDF, one page per slide, in order, each page the picture\'s size', async () => {
        const pdf = await slidesPdf([PNG_1x1, JPG_1x1, PNG_1x1]);
        const doc = await PDFDocument.load(pdf);
        assert.equal(doc.getPageCount(), 3);
        for (const p of doc.getPages()) assert.deepEqual(p.getSize(), { width: 1, height: 1 });
    });

    await check('only PNG and JPEG go into the PDF; a webp names its slide', async () => {
        assert.equal(slideImageKind(PNG_1x1), 'png');
        assert.equal(slideImageKind(JPG_1x1), 'jpg');
        assert.equal(slideImageKind(WEBP), null);
        await assert.rejects(slidesPdf([PNG_1x1, WEBP]), /slide 2 is not a PNG or JPEG/);
    });

    await check('caption text is escaped for the Posts API; hashtags stay hashtags; "#1" is a rank', () => {
        assert.equal(littleText('Top 5 (2026) — #productivity'), 'Top 5 \\(2026\\) — {hashtag|\\#|productivity}');
        assert.equal(littleText('Our #1 pick'), 'Our \\#1 pick');
        assert.equal(littleText('a_b *c* [d] <e> {f} | ~ @g \\'), 'a\\_b \\*c\\* \\[d\\] \\<e\\> \\{f\\} \\| \\~ \\@g \\\\');
        assert.equal(littleText('#AI_tools'), '{hashtag|\\#|AI\\_tools}');
        assert.equal(littleText('C# &#39;'), 'C\\# &\\#39;');
    });

    await check('a link stays one link: its # is escaped, never turned into a hashtag (#712 review)', () => {
        assert.equal(littleText('See https://example.com/#pricing #growth'), 'See https://example.com/\\#pricing {hashtag|\\#|growth}');
        assert.equal(littleText('https://x.co/a_b(c)'), 'https://x.co/a\\_b\\(c\\)');
    });

    await check('only a stored li_document goes out as a document; no stored format never does (#712 review)', () => {
        assert.equal(isLinkedInDocument('li_document'), true);
        assert.equal(isLinkedInDocument(null), false);
        assert.equal(isLinkedInDocument('li_feed'), false);
        assert.equal(isPdfSlideMime('image/JPG'), true);
        assert.equal(isPdfSlideMime('image/gif'), false);
    });

    await check('the router never picks Document carousel from the media alone (autoPick: false)', () => {
        assert.equal(postFormatSpec('li_document')!.autoPick, false);
        const four = Array.from({ length: 4 }, () => ({ kind: 'image' as const, width: 1080, height: 1350 }));
        assert.notEqual(routeAsset('linkedin', four).format?.key, 'li_document', 'no stored format: not a document');
        assert.equal(routeAsset('linkedin', four, 'li_document').format?.key, 'li_document', 'a stored li_document is checked and kept');
        assert.equal(routeAsset('instagram', four).format?.key, 'ig_carousel', 'Instagram still derives its carousel');
    });

    await check('the document wait stays short inside the scheduled run (#712 review)', () => {
        assert.ok(LI_DOCUMENT_POLL_MS * LI_DOCUMENT_MAX_POLLS <= 8000);
    });

    await check('approval: the first slide type a document can\'t carry; unknown types let through (#712 review)', () => {
        const m = new Map<number, string | null>([[1, 'image/png'], [2, 'image/webp'], [3, 'image/jpeg'], [4, null]]);
        assert.equal(nonPdfSlideMime([1, 3, 4], m), null);
        assert.equal(nonPdfSlideMime([1, 2, 3], m), 'image/webp');
        assert.equal(nonPdfSlideMime([9], m), null, 'an asset with no row is the publisher\'s to check');
        const src = readFileSync('netlify/functions/approve-post.ts', 'utf8');
        const i = src.indexOf("if ((post as any).formatKey === 'li_document' && Array.isArray(post.contentAssetIds)");
        assert.ok(i > 0 && i < src.indexOf('const routableAssets = await loadAssetMetrics('), 'checked before the format validation');
        const block = src.slice(i, i + 1600);
        assert.ok(block.includes('const bad = nonPdfSlideMime(ids, new Map(rows.map((r) => [r.id, r.mimeType])));'));
        assert.ok(block.includes("code: 'LI_DOCUMENT_SLIDE_TYPE'"));
    });

    await check('a stranded Document carousel goes to Needs attention, never silently re-posted (#712 review 3)', () => {
        const src = readFileSync('netlify/functions/publish-social-posts.ts', 'utf8');
        const a = src.indexOf("WHERE status = 'publishing' AND platform = 'linkedin' AND format_key = 'li_document'");
        const b = src.indexOf("WHERE status = 'publishing' AND platform IN ('linkedin','x','threads')");
        assert.ok(a > 0 && b > a, 'runs BEFORE the generic re-queue, so the generic one never sees it');
        assert.ok(src.slice(a - 400, a).includes("SET status = 'failed'"));
        assert.match(src, /may already be on LinkedIn\. Check your LinkedIn profile first/);
    });

    await check('the editor never switches to Document carousel by itself either (#712 review 4)', () => {
        const gen = readFileSync('src/generated/platform-constants.js', 'utf8');
        const row = gen.split('\n').find((l) => l.includes('"k":"li_document"'))!;
        assert.ok(row.includes('"ap":false'), 'the flag reaches the browser');
        assert.ok(!gen.split('\n').find((l) => l.includes('"k":"ig_carousel"'))!.includes('"ap"'), 'only li_document carries it');
        const ws = readFileSync('workspace.html', 'utf8');
        assert.ok(ws.includes(".filter(f => f.a === 'live' && f.ap !== false && f.max >= files.length)"), 'photo drop');
        assert.ok(ws.includes(".filter(f => f.a === 'live' && f.ap !== false && _pceFormatAccepts(f, kind)"), 'best format for media');
    });

    await check('a stranded carousel tells its owner, like any failed post (#712 review 4)', () => {
        const src = readFileSync('netlify/functions/publish-social-posts.ts', 'utf8');
        const a = src.indexOf("WHERE status = 'publishing' AND platform = 'linkedin' AND format_key = 'li_document'");
        const block = src.slice(a, a + 1400);
        assert.ok(block.includes('RETURNING id, user_id, assistant_id'));
        assert.ok(block.includes("await createNotification(db, 'post_publish_failed', {"));
    });

    await check('the document title is the cover line, else the first line', () => {
        // The cover's count is fixed to the items really there (fixListCount), exactly as the cover card shows it.
        assert.equal(linkedInDocumentTitle('5 tools we use every day\n\n1. Notion\n2. Figma'), '2 tools we use every day');
        assert.equal(linkedInDocumentTitle('Just words'), 'Just words');
        assert.equal(linkedInDocumentTitle(''), 'Carousel');
    });

    // A stand-in LinkedIn: records every call and answers like Phase 0's real run did.
    function fakeLinkedIn(overrides: { init?: number; postStatus?: number; docStatus?: string } = {}) {
        const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
        const real = globalThis.fetch;
        globalThis.fetch = (async (input: any, init: any = {}) => {
            const url = String(input); const method = init.method ?? 'GET';
            calls.push({ url, method, headers: init.headers ?? {}, body: init.body });
            const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
                new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
            if (url.startsWith('https://media.example/slide')) return new Response(url.endsWith('2') ? JPG_1x1 : PNG_1x1, { status: 200 });
            if (url.includes('/rest/documents?action=initializeUpload')) {
                return overrides.init ? json(overrides.init, { message: 'Not enough permissions' })
                    : json(200, { value: { uploadUrl: 'https://upload.example/doc', document: 'urn:li:document:D1' } });
            }
            if (url === 'https://upload.example/doc') return new Response('', { status: 201 });
            if (url.includes('/rest/documents/')) return json(200, { status: overrides.docStatus ?? 'AVAILABLE' });
            if (url.endsWith('/rest/posts')) {
                return overrides.postStatus ? json(overrides.postStatus, { message: 'bad request' })
                    : new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } });
            }
            throw new Error(`unexpected fetch ${method} ${url}`);
        }) as typeof fetch;
        return { calls, restore: () => { globalThis.fetch = real; } };
    }
    const slides = [1, 2, 3].map((n) => ({ url: `https://media.example/slide${n}`, mimeType: n === 2 ? 'image/jpeg' : 'image/png' }));

    await check('publisher: initializeUpload → PUT the PDF → poll → POST /rest/posts, pinned version', async () => {
        const li = fakeLinkedIn();
        try {
            const r = await publishLinkedInDocument('Top 5 (2026) #growth', 'tok', 'abc', slides, '5 tools', { pollMs: 0 });
            assert.deepEqual(r, { ok: true, id: 'urn:li:share:99' });
            const order = li.calls.filter((c) => !c.url.startsWith('https://media.example')).map((c) => `${c.method} ${c.url.replace('https://api.linkedin.com', '')}`);
            assert.deepEqual(order, ['POST /rest/documents?action=initializeUpload', 'PUT https://upload.example/doc', `GET /rest/documents/${encodeURIComponent('urn:li:document:D1')}`, 'POST /rest/posts']);
            const init = li.calls.find((c) => c.url.includes('initializeUpload'))!;
            assert.equal(init.headers['Linkedin-Version'], LINKEDIN_REST_VERSION);
            assert.deepEqual(JSON.parse(String(init.body)), { initializeUploadRequest: { owner: 'urn:li:person:abc' } });
            const put = li.calls.find((c) => c.url === 'https://upload.example/doc')!;
            const doc = await PDFDocument.load(new Uint8Array(put.body as Buffer));
            assert.equal(doc.getPageCount(), 3, 'one page per slide');
            const post = JSON.parse(String(li.calls.find((c) => c.url.endsWith('/rest/posts'))!.body));
            assert.equal(post.author, 'urn:li:person:abc');
            assert.equal(post.commentary, 'Top 5 \\(2026\\) {hashtag|\\#|growth}');
            assert.deepEqual(post.content, { media: { title: '5 tools', id: 'urn:li:document:D1' } });
            assert.equal(post.visibility, 'PUBLIC');
            assert.equal(post.lifecycleState, 'PUBLISHED');
        } finally { li.restore(); }
    });

    await check('a Company Page author is passed through as it is', async () => {
        const li = fakeLinkedIn();
        try {
            await publishLinkedInDocument('x', 'tok', 'urn:li:organization:7', slides, 't', { pollMs: 0 });
            const init = li.calls.find((c) => c.url.includes('initializeUpload'))!;
            assert.equal(JSON.parse(String(init.body)).initializeUploadRequest.owner, 'urn:li:organization:7');
        } finally { li.restore(); }
    });

    await check('a document still processing after the wait is a retryable 503, not an unready post (#712 review 3)', async () => {
        const li = fakeLinkedIn({ docStatus: 'PROCESSING' });
        try {
            const r = await publishLinkedInDocument('x', 'tok', 'abc', slides, 't', { pollMs: 0 });
            assert.deepEqual(r, { ok: false, status: 503, error: 'LinkedIn is still processing the document. It will be tried again shortly.' });
            assert.equal(li.calls.filter((c) => c.url.includes('/rest/documents/urn')).length, LI_DOCUMENT_MAX_POLLS);
            assert.ok(!li.calls.some((c) => c.url.endsWith('/rest/posts')));
        } finally { li.restore(); }
    });

    await check('a refused upload is a media failure with LinkedIn\'s status — nothing is posted', async () => {
        const li = fakeLinkedIn({ init: 403 });
        try {
            const r = await publishLinkedInDocument('x', 'tok', 'abc', slides, 't', { pollMs: 0 });
            assert.equal(r.ok, false);
            assert.equal((r as { status: number | null }).status, 403);
            assert.match((r as { error: string }).error, /could not be uploaded to LinkedIn.*Not enough permissions/);
            assert.ok(!li.calls.some((c) => c.url.endsWith('/rest/posts')), 'never posted without the document');
        } finally { li.restore(); }
    });

    await check('a refused post reports LinkedIn\'s status (retry rules read it)', async () => {
        const li = fakeLinkedIn({ postStatus: 500 });
        try {
            const r = await publishLinkedInDocument('x', 'tok', 'abc', slides, 't', { pollMs: 0 });
            assert.deepEqual(r, { ok: false, status: 500, error: 'bad request' });
        } finally { li.restore(); }
    });

    await check('fewer than 2 slides, or a video, is refused before anything is uploaded', async () => {
        const li = fakeLinkedIn();
        try {
            const one = await publishLinkedInDocument('x', 'tok', 'abc', [slides[0]], 't');
            assert.match((one as { error: string }).error, /at least 2 slides/);
            const vid = await publishLinkedInDocument('x', 'tok', 'abc', [slides[0], { url: 'https://media.example/v', mimeType: 'video/mp4' }], 't');
            assert.match((vid as { error: string }).error, /pictures only/);
            assert.equal(li.calls.length, 0);
        } finally { li.restore(); }
    });

    await check('the publish job sends li_document rows through the document publisher, others unchanged', () => {
        const src = readFileSync('netlify/functions/publish-social-posts.ts', 'utf8');
        assert.ok(src.includes('link_url, cta_text, format_key`'), 'format_key is read with the claimed row');
        assert.ok(src.includes('result = isLinkedInDocument(post.format_key)'));
        assert.ok(src.includes('? await publishLinkedInDocument(text, token, creds.externalUserId, image, linkedInDocumentTitle(post.caption))'));
        assert.ok(src.includes(': await publishLinkedIn(text, token, creds.externalUserId, image);'));
    });

    console.log(`\n${passed} passed`);
})();
