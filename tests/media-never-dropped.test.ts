// tests/media-never-dropped.test.ts
//
// A post that HAS media must never publish without it and be recorded as a success.
//
// This is the trust property of the whole product. The old behaviour was the opposite, in two
// places at once:
//   • publishX and publishLinkedIn caught a media-upload failure and posted the caption alone
//     (`catch { /* text-only on media failure */ }`)
//   • the publishers treated an unresolvable asset as "text-only" via `.catch(() => null)`
// Either way the user's designed post went out as a bare caption on a live feed, the queue said
// "published", and nothing recorded that the picture had been dropped. Failing is recoverable —
// the post stays in the queue and can be retried. A stripped post on a public timeline is not.
//
// NOT COVERED: the live APIs. These assert the DECISION, which is where the bug was.
//
// Run:  npx tsx tests/media-never-dropped.test.ts

import assert from 'node:assert';
import { publishX, publishLinkedIn, hasAttachedMedia } from '../src/utils/social-publish';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const IMAGE = { url: 'https://r2.example.com/presigned/pic.jpg', mimeType: 'image/jpeg' };
const realFetch = globalThis.fetch;

/** Swap in a fetch that answers per-URL, and record what was actually sent. */
function withFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        return handler(url, init);
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function main() {
    console.log('\nMedia is never silently dropped\n');

    await check('X: a failed media upload fails the post instead of tweeting the text alone', async () => {
        const f = withFetch((url) => {
            if (url.includes('/media/upload')) return json({ errors: [{ message: 'boom' }] }, 400);
            return json({ data: { id: '1' } });
        });
        try {
            const res = await publishX('Look at this', 'tok', IMAGE) as { ok: boolean; error?: string; id?: string };
            assert.equal(res.ok, false, 'a dropped image must not report success');
            assert.match(res.error ?? '', /media could not be uploaded to X/i);
            assert.ok(!f.calls.some(u => u.endsWith('/2/tweets')), 'the tweet must NOT be sent without its media');
        } finally { f.restore(); }
    });

    await check('X: a throwing media upload also fails, carrying the reason', async () => {
        const f = withFetch((url) => {
            if (url.includes('/media/upload')) throw new Error('socket hang up');
            return json({ data: { id: '1' } });
        });
        try {
            const res = await publishX('Look at this', 'tok', IMAGE) as { ok: boolean; error?: string; id?: string };
            assert.equal(res.ok, false);
            assert.match(res.error ?? '', /socket hang up/, 'the underlying reason must survive to the queue');
        } finally { f.restore(); }
    });

    await check('X: a genuine text-only post still publishes', async () => {
        const f = withFetch(() => json({ data: { id: '99' } }));
        try {
            const res = await publishX('Just words', 'tok', null) as { ok: boolean; error?: string; id?: string };
            assert.equal(res.ok, true, 'a post with no media attached is a legitimate text post');
            assert.equal(res.id, '99');
        } finally { f.restore(); }
    });

    await check('LinkedIn: a failed asset upload fails the post', async () => {
        const f = withFetch((url) => {
            if (url.includes('registerUpload')) return json({ message: 'nope' }, 403);
            return json({ id: 'urn:li:share:1' });
        });
        try {
            const res = await publishLinkedIn('Hello', 'tok', 'urn:li:person:abc', IMAGE) as { ok: boolean; error?: string };
            assert.equal(res.ok, false);
            assert.match(res.error ?? '', /media could not be uploaded to LinkedIn/i);
            assert.ok(!f.calls.some(u => u.includes('ugcPosts')), 'the share must NOT go out without its image');
        } finally { f.restore(); }
    });

    await check('LinkedIn: a genuine text-only post still publishes', async () => {
        const f = withFetch(() => json({ id: 'urn:li:share:7' }));
        try {
            const res = await publishLinkedIn('Hello', 'tok', 'urn:li:person:abc', null) as { ok: boolean; error?: string };
            assert.equal(res.ok, true);
        } finally { f.restore(); }
    });

    console.log('\n…and the publishers can tell the two cases apart\n');

    await check('hasAttachedMedia distinguishes "no media" from "media we could not load"', () => {
        assert.equal(hasAttachedMedia([12, 13]), true);
        assert.equal(hasAttachedMedia([]), false);
        assert.equal(hasAttachedMedia(null), false);
        assert.equal(hasAttachedMedia(undefined), false);
        // Junk ids are not media — a post carrying only these is text, not a broken image post.
        assert.equal(hasAttachedMedia(['nonsense']), false);
        assert.equal(hasAttachedMedia([1, 'nonsense']), true);
    });

    await check('both publishers refuse rather than strip, when media will not resolve', () => {
        // The decision lives inline in the publishers, so assert on the source: the guard must be
        // present and must fail the post rather than continue to the driver.
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        for (const f of ['publish-social-posts.ts', 'publish-facebook.ts']) {
            const src = readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8');
            assert.ok(src.includes('hasAttachedMedia('), `${f} must check for attached-but-unresolvable media`);
            assert.match(src, /media attached but it could not be loaded/, `${f} must say so, not publish bare`);
        }
    });

    console.log(`\n${passed}/7 passed\n`);
}

main();
