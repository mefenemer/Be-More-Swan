// tests/linkedin-media-failure.test.ts
//
// What LinkedIn tells us when a media upload fails, and whether that survives the trip to
// failure_reason. The sibling file tests/x-media-failure.test.ts asserts the same guarantee for X,
// and exists because of three real prod rows shaped like this:
//
//   {"httpStatus": null, "isRetryable": false,
//    "errorMessage": "The media could not be uploaded to X, so the post was not sent.
//                     Try again, or replace the media."}
//
// uploadLinkedInImage had the identical defect — `return null` on a failed registerUpload AND on a
// failed byte upload, discarding LinkedIn's status and its body. Nothing had produced that row for
// LinkedIn yet (it publishes fine today), which is exactly why it is worth pinning: the failure is
// latent, and when it fires it breaks two things at once.
//
//   • DIAGNOSIS — LinkedIn had said whether this was an expired token, a missing w_member_social
//     scope, an oversized file or an unsupported recipe. None of it reached the queue, so the row
//     is unactionable forever; you cannot even tell whether retrying could ever work.
//   • RETRY — publish-social-posts classifies retryability from the status alone
//     (`isRetryable = s === 429 || s >= 500`, the same rule as isDriverRetryable). A null status is
//     PERMANENT, so a rate-limited or briefly-500ing upload would burn the post on attempt 1
//     rather than backing off.
//
// LinkedIn has TWO upload hops (registerUpload on api.linkedin.com, then the bytes to a different
// media host), so every case below is asserted on both — a hop that swallows its status is just as
// dead as the whole path swallowing it.
//
// NOT COVERED: the live API. These prove what we do with what LinkedIn returns.
//
// Run:  npx tsx tests/linkedin-media-failure.test.ts

import assert from 'node:assert';
import { publishLinkedIn, isDriverRetryable } from '../src/utils/social-publish';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const IMAGE = { url: 'https://r2.example.com/card.jpg', mimeType: 'image/jpeg' };
const VIDEO = { url: 'https://r2.example.com/short.mp4', mimeType: 'video/mp4' };
const AUTHOR = 'urn:li:person:abc123';
const UPLOAD_URL = 'https://media-upload.linkedin.com/uploads/asset-1';
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The successful registerUpload body: the asset URN plus the host to PUT the bytes at. */
const REGISTERED = {
    value: {
        asset: 'urn:li:digitalmediaAsset:asset-1',
        uploadMechanism: {
            'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: UPLOAD_URL },
        },
    },
};

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

const isRegister = (url: string) => url.includes('registerUpload');
const isBytes = (url: string) => url.startsWith(UPLOAD_URL);
const isPost = (url: string) => url.includes('/v2/ugcPosts');

const posted = () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } });

type Failure = { ok: false; status: number | null; error: string };

async function main() {
    // The whole point: these differ ONLY in what LinkedIn answered, and they must reach opposite
    // verdicts. Under the old `return null` they were byte-identical rows.
    const classifications: Array<[string, number, boolean]> = [
        ['429 rate limit',          429, true],
        ['500 upstream error',      500, true],
        ['503 unavailable',         503, true],
        ['401 expired token',       401, false],
        ['403 missing scope',       403, false],
        ['400 rejected image',      400, false],
        ['422 unsupported recipe',  422, false],
    ];

    console.log('\nLinkedIn registerUpload — the status survives, so retry classification is right\n');

    for (const [label, status, retryable] of classifications) {
        await check(`registerUpload ${label} → status ${status}, isRetryable=${retryable}`, async () => {
            const f = withFetch((url) => {
                if (isRegister(url)) return json({ message: `LinkedIn said ${status}` }, status);
                return posted();
            });
            try {
                const res = await publishLinkedIn('caption', 'tok', AUTHOR, IMAGE) as Failure;
                assert.equal(res.ok, false);
                assert.equal(res.status, status, 'LinkedIn\'s HTTP status must reach the DriverResult');
                assert.equal(isDriverRetryable(res.status), retryable);
                assert.ok(!f.calls.some(isPost),
                    'a post whose media failed must never go out as a bare caption');
            } finally { f.restore(); }
        });
    }

    console.log('\nLinkedIn byte upload — the second hop must not swallow its status either\n');

    for (const [label, status, retryable] of classifications) {
        await check(`byte upload ${label} → status ${status}, isRetryable=${retryable}`, async () => {
            const f = withFetch((url) => {
                if (isRegister(url)) return json(REGISTERED);
                if (isBytes(url)) return json({ message: `LinkedIn said ${status}` }, status);
                return posted();
            });
            try {
                const res = await publishLinkedIn('caption', 'tok', AUTHOR, IMAGE) as Failure;
                assert.equal(res.ok, false);
                assert.equal(res.status, status);
                assert.equal(isDriverRetryable(res.status), retryable);
                assert.ok(!f.calls.some(isPost),
                    'a post whose media failed must never go out as a bare caption');
            } finally { f.restore(); }
        });
    }

    console.log('\nLinkedIn\'s own words reach the Review Queue\n');

    await check('a registerUpload message survives, not the generic fallback', async () => {
        const f = withFetch((url) =>
            isRegister(url)
                ? json({ message: 'Not enough permissions to access: registerUpload.ASSETS' }, 403)
                : posted());
        try {
            const res = await publishLinkedIn('caption', 'tok', AUTHOR, IMAGE) as Failure;
            assert.match(res.error, /Not enough permissions to access/);
            // The exact tail from the prod rows — its presence means we learned nothing.
            assert.doesNotMatch(res.error, /Try again, or replace the media\.$/,
                'the generic fallback must only appear when LinkedIn gave us no reason at all');
        } finally { f.restore(); }
    });

    await check('a byte-upload message survives too', async () => {
        const f = withFetch((url) => {
            if (isRegister(url)) return json(REGISTERED);
            if (isBytes(url)) return json({ message: 'The file exceeds the maximum allowed size.' }, 400);
            return posted();
        });
        try {
            const res = await publishLinkedIn('caption', 'tok', AUTHOR, IMAGE) as Failure;
            assert.match(res.error, /exceeds the maximum allowed size/);
            assert.equal(isDriverRetryable(res.status), false);
        } finally { f.restore(); }
    });

    await check('a non-JSON body from the media host still yields the status', async () => {
        // media-upload.linkedin.com is not api.linkedin.com and does not always answer in JSON.
        const f = withFetch((url) => {
            if (isRegister(url)) return json(REGISTERED);
            if (isBytes(url)) return new Response('<html>502 Bad Gateway</html>', { status: 502 });
            return posted();
        });
        try {
            const res = await publishLinkedIn('caption', 'tok', AUTHOR, IMAGE) as Failure;
            assert.equal(res.status, 502);
            assert.equal(isDriverRetryable(res.status), true, 'a gateway blip must back off, not burn the post');
            assert.match(res.error, /LinkedIn media upload failed \(502\)/);
        } finally { f.restore(); }
    });

    await check('a 2xx registration with no asset URN fails with the status, not a bare null', async () => {
        const f = withFetch((url) => (isRegister(url) ? json({ value: {} }, 200) : posted()));
        try {
            const res = await publishLinkedIn('caption', 'tok', AUTHOR, IMAGE) as Failure;
            assert.equal(res.ok, false);
            assert.equal(res.status, 200);
            assert.match(res.error, /no asset URN/);
        } finally { f.restore(); }
    });

    await check('a 2xx registration with no upload URL fails with the status too', async () => {
        const f = withFetch((url) =>
            isRegister(url)
                ? json({ value: { asset: 'urn:li:digitalmediaAsset:asset-1' } }, 200)
                : posted());
        try {
            const res = await publishLinkedIn('caption', 'tok', AUTHOR, IMAGE) as Failure;
            assert.equal(res.status, 200);
            assert.match(res.error, /no upload URL/);
        } finally { f.restore(); }
    });

    await check('video fails the same way — one path serves both recipes', async () => {
        const f = withFetch((url) => {
            if (isRegister(url)) return json({ message: 'Video processing is unavailable.' }, 503);
            return posted();
        });
        try {
            const res = await publishLinkedIn('caption', 'tok', AUTHOR, VIDEO) as Failure;
            assert.equal(res.status, 503);
            assert.match(res.error, /Video processing is unavailable/);
            assert.equal(isDriverRetryable(res.status), true);
        } finally { f.restore(); }
    });

    await check('one failed slide of a carousel fails the whole post', async () => {
        // Registering slide 2 fails: publishing slides 1-and-3 would be a post the user never
        // designed, so the post must not go out at all.
        let registrations = 0;
        const f = withFetch((url) => {
            if (isRegister(url)) return ++registrations === 2 ? json({ message: 'Throttled' }, 429) : json(REGISTERED);
            if (isBytes(url)) return json({});
            return posted();
        });
        try {
            const res = await publishLinkedIn('caption', 'tok', AUTHOR, [IMAGE, IMAGE, IMAGE]) as Failure;
            assert.equal(res.status, 429);
            assert.equal(isDriverRetryable(res.status), true);
            assert.ok(!f.calls.some(isPost), 'no partial carousel may be published');
        } finally { f.restore(); }
    });

    console.log('\nUnchanged behaviour\n');

    await check('a successful image post still attaches the asset URN', async () => {
        let body: any = null;
        const f = withFetch((url, init) => {
            if (isRegister(url)) return json(REGISTERED);
            if (isBytes(url)) return json({});
            body = JSON.parse(String(init?.body));
            return posted();
        });
        try {
            const res = await publishLinkedIn('hello', 'tok', AUTHOR, IMAGE);
            assert.equal(res.ok, true);
            const content = body.specificContent['com.linkedin.ugc.ShareContent'];
            assert.equal(content.shareMediaCategory, 'IMAGE');
            assert.deepEqual(content.media, [{ status: 'READY', media: 'urn:li:digitalmediaAsset:asset-1' }]);
        } finally { f.restore(); }
    });

    await check('a text-only post never touches the upload path', async () => {
        const f = withFetch((url) => (isPost(url) ? posted() : json({}, 500)));
        try {
            const res = await publishLinkedIn('hello', 'tok', AUTHOR, null);
            assert.equal(res.ok, true);
            assert.ok(!f.calls.some(isRegister), 'no media, no registerUpload');
        } finally { f.restore(); }
    });

    await check('the video-in-a-carousel guard still fires before any upload', async () => {
        const f = withFetch(() => json({}));
        try {
            const res = await publishLinkedIn('x', 'tok', AUTHOR, [IMAGE, VIDEO]) as Failure;
            assert.equal(res.ok, false);
            assert.match(res.error, /cannot include a video/);
            assert.equal(f.calls.length, 0, 'the guard must run before we spend an upload');
        } finally { f.restore(); }
    });

    console.log(`\n${passed} passed\n`);
}

main();
