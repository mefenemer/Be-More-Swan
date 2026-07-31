// tests/x-media-failure.test.ts
//
// What X tells us when a media upload fails, and whether that survives the trip to failure_reason.
//
// These assertions exist because of three real prod rows on 2026-07-23/30/31, every one of them
// this shape:
//
//   {"httpStatus": null, "isRetryable": false,
//    "errorMessage": "The media could not be uploaded to X, so the post was not sent.
//                     Try again, or replace the media."}
//
// uploadXMedia's image path did `return res.ok ? id : null`, throwing away X's status AND its body.
// Two things broke at once, and only one of them is visible:
//
//   • DIAGNOSIS — X had said whether this was an expired token, a missing media.write scope, an
//     oversized file or a rejected format. None of it reached the queue, so the row is unactionable
//     forever; you cannot even tell whether retrying could ever work.
//   • RETRY — publish-social-posts classifies retryability from the status alone
//     (`isRetryable = s === 429 || s >= 500`). A null status is PERMANENT, so a rate-limited or
//     briefly-500ing upload burned the post on attempt 1 rather than backing off. This is the
//     expensive half, and it is silent: nothing distinguishes "X is busy" from "this image is
//     unusable" once the status is gone.
//
// The video path always threw with X's message, so it was diagnosable but still misclassified —
// a bare Error carries no status either. Both paths now throw MediaUploadError.
//
// NOT COVERED: the live API. These prove what we do with what X returns.
//
// Run:  npx tsx tests/x-media-failure.test.ts

import assert from 'node:assert';
import { publishX, isDriverRetryable } from '../src/utils/social-publish';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const IMAGE = { url: 'https://r2.example.com/card.jpg', mimeType: 'image/jpeg' };
const VIDEO = { url: 'https://r2.example.com/short.mp4', mimeType: 'video/mp4' };
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Media bytes come from R2 via fetchImageBytes, so the mock must answer that too.
function withFetch(handler: (url: string, init?: RequestInit) => Response) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('https://r2.example.com/')) return new Response(new ArrayBuffer(64), { status: 200 });
        return handler(url, init);
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

type Failure = { ok: false; status: number | null; error: string };

async function main() {
    console.log('\nX image upload — the status survives, so retry classification is right\n');

    // The whole point: these two differ ONLY in what X answered, and they must reach opposite
    // verdicts. Under the old `return null` they were byte-identical rows.
    const classifications: Array<[string, number, boolean]> = [
        ['429 rate limit',        429, true],
        ['500 upstream error',    500, true],
        ['503 unavailable',       503, true],
        ['401 expired token',     401, false],
        ['403 missing scope',     403, false],
        ['400 rejected image',    400, false],
        ['413 file too large',    413, false],
    ];

    for (const [label, status, retryable] of classifications) {
        await check(`${label} → status ${status}, isRetryable=${retryable}`, async () => {
            const f = withFetch((url) => {
                if (url.includes('/2/media/upload')) return json({ detail: `X said ${status}` }, status);
                return json({ data: { id: 'tweet-1' } });
            });
            try {
                const res = await publishX('caption', 'tok', IMAGE) as Failure;
                assert.equal(res.ok, false);
                assert.equal(res.status, status, 'X\'s HTTP status must reach the DriverResult');
                assert.equal(isDriverRetryable(res.status), retryable);
                assert.ok(!f.calls.some(c => c.includes('/2/tweets')),
                    'a post whose media failed must never go out as a bare caption');
            } finally { f.restore(); }
        });
    }

    await check('X\'s own message reaches the queue, not the generic fallback', async () => {
        const f = withFetch((url) =>
            url.includes('/2/media/upload')
                ? json({ detail: 'Your account is not permitted to upload media.' }, 403)
                : json({ data: { id: 'tweet-1' } }));
        try {
            const res = await publishX('caption', 'tok', IMAGE) as Failure;
            assert.match(res.error, /not permitted to upload media/);
            // The exact string from the three prod rows — its presence means we learned nothing.
            assert.doesNotMatch(res.error, /Try again, or replace the media\.$/,
                'the generic fallback must only appear when X gave us no reason at all');
        } finally { f.restore(); }
    });

    await check('title and errors[] are honoured when detail is absent', async () => {
        const f = withFetch((url) =>
            url.includes('/2/media/upload') ? json({ title: 'PayloadTooLarge' }, 413) : json({ data: { id: 't' } }));
        try {
            const res = await publishX('caption', 'tok', IMAGE) as Failure;
            assert.match(res.error, /PayloadTooLarge/);
        } finally { f.restore(); }
    });

    await check('a 2xx carrying no media id fails with the status, not a bare null', async () => {
        const f = withFetch((url) =>
            url.includes('/2/media/upload') ? json({ data: {} }, 200) : json({ data: { id: 't' } }));
        try {
            const res = await publishX('caption', 'tok', IMAGE) as Failure;
            assert.equal(res.ok, false);
            assert.equal(res.status, 200);
            assert.match(res.error, /no media id/);
        } finally { f.restore(); }
    });

    await check('an unparseable error body still yields the status', async () => {
        const f = withFetch((url) =>
            url.includes('/2/media/upload')
                ? new Response('<html>502 Bad Gateway</html>', { status: 502 })
                : json({ data: { id: 't' } }));
        try {
            const res = await publishX('caption', 'tok', IMAGE) as Failure;
            assert.equal(res.status, 502);
            assert.equal(isDriverRetryable(res.status), true, 'a gateway blip must back off, not burn the post');
        } finally { f.restore(); }
    });

    console.log('\nX video upload — same guarantee through the chunked path\n');

    await check('a failed INIT carries its status', async () => {
        const f = withFetch((url) =>
            url.includes('/2/media/upload/initialize')
                ? json({ detail: 'Media type not supported' }, 400)
                : json({ data: { id: 't' } }));
        try {
            const res = await publishX('caption', 'tok', VIDEO) as Failure;
            assert.equal(res.status, 400);
            assert.match(res.error, /Media type not supported/);
            assert.equal(isDriverRetryable(res.status), false);
        } finally { f.restore(); }
    });

    await check('a failed APPEND carries its status and is retryable on 5xx', async () => {
        const f = withFetch((url) => {
            if (url.includes('/initialize')) return json({ data: { id: 'm-1' } });
            if (url.includes('/append')) return json({ detail: 'Upstream failure' }, 503);
            return json({ data: { id: 't' } });
        });
        try {
            const res = await publishX('caption', 'tok', VIDEO) as Failure;
            assert.equal(res.status, 503);
            assert.equal(isDriverRetryable(res.status), true);
        } finally { f.restore(); }
    });

    await check('transcoding that outlasts our polls promises a retry AND gets one', async () => {
        // The message has always said "It will be retried shortly". As a bare Error it reported
        // status null, which classifies permanent — the sentence was a lie for as long as it existed.
        const f = withFetch((url) => {
            if (url.includes('/initialize')) return json({ data: { id: 'm-1' } });
            if (url.includes('/append')) return json({});
            if (url.includes('/finalize')) return json({ data: { processing_info: { state: 'in_progress', check_after_secs: 0 } } });
            if (url.includes('command=STATUS')) return json({ data: { processing_info: { state: 'in_progress', check_after_secs: 0 } } });
            return json({ data: { id: 't' } });
        });
        try {
            const res = await publishX('caption', 'tok', VIDEO) as Failure;
            assert.match(res.error, /still processing/i);
            assert.equal(isDriverRetryable(res.status), true, 'the status must match what the message promises');
        } finally { f.restore(); }
    });

    await check('a video X rejects outright is permanent — retrying the same file cannot help', async () => {
        const f = withFetch((url) => {
            if (url.includes('/initialize')) return json({ data: { id: 'm-1' } });
            if (url.includes('/append')) return json({});
            if (url.includes('/finalize')) return json({ data: { processing_info: { state: 'failed', error: { message: 'UnsupportedCodec' } } } });
            return json({ data: { id: 't' } });
        });
        try {
            const res = await publishX('caption', 'tok', VIDEO) as Failure;
            assert.match(res.error, /UnsupportedCodec/);
            assert.equal(isDriverRetryable(res.status), false);
        } finally { f.restore(); }
    });

    console.log('\nUnchanged behaviour\n');

    await check('a successful image post still attaches media_ids', async () => {
        let tweetBody: any = null;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith('https://r2.example.com/')) return new Response(new ArrayBuffer(64), { status: 200 });
            if (url.includes('/2/media/upload')) return json({ data: { id: 'media-9' } });
            tweetBody = JSON.parse(String(init?.body));
            return json({ data: { id: 'tweet-9' } });
        }) as typeof fetch;
        try {
            const res = await publishX('hello', 'tok', IMAGE);
            assert.equal(res.ok, true);
            assert.deepEqual(tweetBody.media, { media_ids: ['media-9'] });
        } finally { globalThis.fetch = realFetch; }
    });

    await check('the images/video mix guard still fires before any upload', async () => {
        const f = withFetch(() => json({}));
        try {
            const res = await publishX('x', 'tok', [IMAGE, VIDEO]) as Failure;
            assert.equal(res.ok, false);
            assert.match(res.error, /one video or up to four images/);
            assert.equal(f.calls.length, 0, 'the guard must run before we spend an upload');
        } finally { f.restore(); }
    });

    console.log(`\n${passed} passed\n`);
}

main();
