// tests/youtube-resumable-upload.test.ts
// Chunked resumable upload for YouTube (src/utils/social-publish.ts).
//
// Run:  npx tsx tests/youtube-resumable-upload.test.ts
//
// WHY THIS EXISTS: the driver replaced a single buffered PUT (Buffer.from(await res.arrayBuffer()))
// whose failure mode — exhausting the function's memory on a long-form video — only shows up on
// files too big to put in a test. So these tests assert the property that makes the size irrelevant:
// no single request ever carries more than one chunk, and the bytes YouTube ends up with are
// byte-identical to the source. A regression that reintroduces whole-file buffering breaks the
// "never holds more than one chunk" assertion even with a 1 MB fixture.
//
// The fake YouTube below is deliberately STRICT about the resumable contract — it rejects a
// non-contiguous Content-Range rather than papering over it — because the offset bookkeeping after
// a 308, a retry, or a cross-invocation resume is exactly the part that's easy to get wrong.
//
// NOT COVERED: the live API. Content-Range handling, real 308 semantics and session expiry can only
// be proven against Google. Use social-publish-selftest for that.

import assert from 'node:assert';
import {
    publishYouTube, publishYouTubeResumable, youtubeMetaFromCaption, resolvePostVideo,
    YOUTUBE_DEFAULT_PRIVACY,
} from '../src/utils/social-publish';

let passed = 0;
let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failures++; console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SOURCE_URL = 'https://r2.example.com/presigned/video.mp4';
const SESSION_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session-123';
const META = { title: 'Test video', description: 'desc', tags: ['a', 'b'] };
const VIDEO = { url: SOURCE_URL, mimeType: 'video/mp4' };
const CHUNK = 256 * 1024;

/** Deterministic pseudo-random bytes — a repeating pattern would hide an off-by-one in the offsets. */
function makeVideo(size: number): Buffer {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + (i >> 8) * 17) & 0xff;
    return buf;
}

interface FakeOpts {
    video: Buffer;
    rangeSupported?: boolean;
    /** Bytes the session accepts per PUT; less than sent → a short 308, forcing a resume. */
    acceptLimit?: number;
    /** Indices (0-based, of PUTs carrying bytes) that fail once with this status. */
    failOnce?: Map<number, number>;
    initStatus?: number;
    /** Non-2xx from the source, simulating an expired presign or a deleted object. */
    sourceStatus?: number;
    /** Session wedges: every PUT answers 308 pinned to this same offset, never advancing. */
    stallAtOffset?: number;
    /** Offset queries answer with this status, simulating a session YouTube has dropped. */
    offsetQueryStatus?: number;
    /** Source honours Range for the probe, then stops honouring it for subsequent chunk reads. */
    rangeStopsAfterProbe?: boolean;
}

interface FakeState {
    received: Buffer;
    maxBodyBytes: number;
    contentRanges: string[];
    offsetQueries: number;
    streamedPuts: number;
    sessionsOpened: number;
    uploadContentType: string | null;
    uploadContentLength: string | null;
    privacyStatus: string | null;
}

// Installs a globalThis.fetch emulating the R2 source + YouTube's resumable endpoint.
function installFake(opts: FakeOpts): { state: FakeState; restore: () => void } {
    const {
        video, rangeSupported = true, acceptLimit, failOnce = new Map(),
        initStatus = 200, sourceStatus, stallAtOffset, offsetQueryStatus, rangeStopsAfterProbe,
    } = opts;
    let sourceReads = 0;
    const state: FakeState = {
        received: Buffer.alloc(0), maxBodyBytes: 0, contentRanges: [], offsetQueries: 0,
        streamedPuts: 0, sessionsOpened: 0, uploadContentType: null, uploadContentLength: null,
        privacyStatus: null,
    };
    const realFetch = globalThis.fetch;
    let bytePutIndex = -1;

    globalThis.fetch = (async (input: any, init: any = {}) => {
        const url = String(input);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);

        // ── The source object store ──
        if (url === SOURCE_URL) {
            if (sourceStatus) return new Response('gone', { status: sourceStatus });
            const range = headers.range;
            // First read is the 0-0 probe; after that, pretend Range support vanished.
            const honourRange = rangeSupported && !(rangeStopsAfterProbe && sourceReads++ > 0);
            if (range && honourRange) {
                const m = /bytes=(\d+)-(\d+)?/.exec(range)!;
                const start = Number(m[1]);
                const end = m[2] == null ? video.length - 1 : Math.min(Number(m[2]), video.length - 1);
                const slice = video.subarray(start, end + 1);
                return new Response(new Uint8Array(slice), {
                    status: 206,
                    headers: { 'content-range': `bytes ${start}-${end}/${video.length}`, 'content-type': 'video/mp4' },
                });
            }
            // Range unsupported (or none asked): hand back the whole object.
            return new Response(new Uint8Array(video), {
                status: 200,
                headers: { 'content-length': String(video.length), 'content-type': 'video/mp4' },
            });
        }

        // ── Session open ──
        if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable')) {
            state.sessionsOpened++;
            state.uploadContentType = headers['x-upload-content-type'] ?? null;
            state.uploadContentLength = headers['x-upload-content-length'] ?? null;
            try { state.privacyStatus = JSON.parse(init.body).status?.privacyStatus ?? null; } catch { /* no body */ }
            if (initStatus !== 200) {
                return new Response(JSON.stringify({ error: { message: 'Daily upload limit exceeded.' } }), { status: initStatus });
            }
            return new Response('', { status: 200, headers: { location: SESSION_URL } });
        }

        // ── Session PUTs ──
        if (url === SESSION_URL && init.method === 'PUT') {
            const cr = headers['content-range'] ?? '';

            // Offset query: `bytes */total`, empty body.
            if (/^bytes \*\/\d+$/.test(cr)) {
                state.offsetQueries++;
                if (offsetQueryStatus) return new Response('gone', { status: offsetQueryStatus });
                return new Response('', {
                    status: 308,
                    headers: state.received.length ? { range: `bytes=0-${state.received.length - 1}` } : {},
                });
            }

            // Read the body — Buffer (chunked path) or a stream (fallback path).
            let body: Buffer;
            if (init.body && typeof init.body.getReader === 'function') {
                state.streamedPuts++;
                const chunks: Buffer[] = [];
                const reader = init.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(Buffer.from(value));
                }
                body = Buffer.concat(chunks);
            } else {
                body = Buffer.from(init.body);
            }

            bytePutIndex++;
            state.maxBodyBytes = Math.max(state.maxBodyBytes, body.byteLength);
            if (cr) state.contentRanges.push(cr);

            if (stallAtOffset != null) {
                return new Response('', { status: 308, headers: { range: `bytes=0-${stallAtOffset - 1}` } });
            }

            const failStatus = failOnce.get(bytePutIndex);
            if (failStatus != null) {
                failOnce.delete(bytePutIndex);
                return new Response(JSON.stringify({ error: { message: 'Backend error' } }), { status: failStatus });
            }

            if (cr) {
                const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
                assert.ok(m, `malformed Content-Range: ${cr}`);
                const start = Number(m![1]), end = Number(m![2]), total = Number(m![3]);
                assert.strictEqual(total, video.length, 'Content-Range total must be the real file size');
                assert.strictEqual(end - start + 1, body.byteLength, 'Content-Range width must match the body length');
                assert.strictEqual(start, state.received.length, `non-contiguous chunk: got ${start}, session is at ${state.received.length}`);
            }

            const stored = acceptLimit != null ? body.subarray(0, Math.min(acceptLimit, body.byteLength)) : body;
            state.received = Buffer.concat([state.received, stored]);

            if (state.received.length >= video.length) {
                return new Response(JSON.stringify({ id: 'yt-video-id' }), { status: 200 });
            }
            return new Response('', { status: 308, headers: { range: `bytes=0-${state.received.length - 1}` } });
        }

        throw new Error(`unexpected fetch: ${init.method ?? 'GET'} ${url}`);
    }) as typeof fetch;

    return { state, restore: () => { globalThis.fetch = realFetch; } };
}

async function main(): Promise<void> {
console.log('\nYouTube resumable upload\n');

// ── Chunking: the memory fix ──────────────────────────────────────────────────────────────────

await check('uploads in chunks and reassembles byte-identically', async () => {
    const video = makeVideo(1024 * 1024 + 7);   // deliberately not a chunk multiple
    const { state, restore } = installFake({ video });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.strictEqual(outcome.kind, 'done', outcome.kind === 'failed' ? outcome.error : '');
        assert.ok(state.received.equals(video), 'YouTube did not receive the exact source bytes');
    } finally { restore(); }
});

await check('never holds more than one chunk in a single request', async () => {
    const video = makeVideo(1024 * 1024 + 7);
    const { state, restore } = installFake({ video });
    try {
        await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.ok(
            state.maxBodyBytes <= CHUNK,
            `a request carried ${state.maxBodyBytes} bytes — whole-file buffering has regressed`,
        );
        assert.ok(state.contentRanges.length >= 4, `expected several chunks, saw ${state.contentRanges.length}`);
        // The final chunk must be the short remainder, not padded out.
        assert.match(state.contentRanges.at(-1)!, /^bytes \d+-1048582\/1048583$/);
    } finally { restore(); }
});

await check('rounds a non-multiple chunk size down to a 256 KiB boundary', async () => {
    const video = makeVideo(900 * 1024);
    const { state, restore } = installFake({ video });
    try {
        await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: 300 * 1024 });   // → 256 KiB
        const first = /^bytes 0-(\d+)\//.exec(state.contentRanges[0])!;
        assert.strictEqual(Number(first[1]) + 1, CHUNK, 'non-final chunk must be a 256 KiB multiple');
    } finally { restore(); }
});

await check('resumes from the offset YouTube reports on a short 308', async () => {
    const video = makeVideo(1024 * 1024);
    // Accept only half of each chunk — every 308 reports an offset behind what we sent.
    const { state, restore } = installFake({ video, acceptLimit: 128 * 1024 });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.strictEqual(outcome.kind, 'done', outcome.kind === 'failed' ? outcome.error : '');
        assert.ok(state.received.equals(video), 'resume produced corrupt bytes — offsets drifted');
    } finally { restore(); }
});

await check('retries a transient 500 and re-syncs the offset', async () => {
    const video = makeVideo(1024 * 1024);
    const { state, restore } = installFake({ video, failOnce: new Map([[1, 500]]) });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.strictEqual(outcome.kind, 'done', outcome.kind === 'failed' ? outcome.error : '');
        assert.strictEqual(state.offsetQueries, 1, 'a failed chunk must re-query the session offset');
        assert.ok(state.received.equals(video), 'retry produced corrupt bytes');
    } finally { restore(); }
});

await check('gives up after repeated failures rather than looping', async () => {
    const video = makeVideo(512 * 1024);
    const { restore } = installFake({ video, failOnce: new Map([[0, 500], [1, 500], [2, 500], [3, 500], [4, 500]]) });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.strictEqual(outcome.kind, 'failed');
        assert.strictEqual(outcome.kind === 'failed' ? outcome.status : null, 500);
    } finally { restore(); }
});

await check('bails out instead of spinning when a 308 never advances', async () => {
    // Without a stall guard this loops until the function times out — invisible until production.
    const video = makeVideo(1024 * 1024);
    const { restore } = installFake({ video, stallAtOffset: CHUNK });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.strictEqual(outcome.kind, 'failed', 'expected failure rather than an infinite loop');
        assert.match(outcome.kind === 'failed' ? outcome.error : '', /stopped accepting the upload/);
    } finally { restore(); }
});

await check('falls back to a streamed PUT when the source ignores Range', async () => {
    const video = makeVideo(600 * 1024);
    const { state, restore } = installFake({ video, rangeSupported: false });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.strictEqual(outcome.kind, 'done', outcome.kind === 'failed' ? outcome.error : '');
        assert.strictEqual(state.streamedPuts, 1, 'fallback must stream the body, not buffer it');
        assert.ok(state.received.equals(video), 'streamed bytes differ from source');
    } finally { restore(); }
});

await check('refuses to buffer the whole file if the source stops honouring Range', async () => {
    // The chunk loop accepts a 200 (legitimate when the window spans the whole object), but a 200
    // carrying the ENTIRE video mid-upload would reintroduce exactly the whole-file buffering this
    // driver exists to remove. It must bail on the advertised length, before reading the body.
    const video = makeVideo(4 * 1024 * 1024);
    const { state, restore } = installFake({ video, rangeStopsAfterProbe: true });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.strictEqual(outcome.kind, 'failed', 'expected a clean failure, not a 4 MB buffer');
        assert.match(outcome.kind === 'failed' ? outcome.error : '', /stopped honouring range/);
        assert.ok(
            state.maxBodyBytes <= CHUNK,
            `a request carried ${state.maxBodyBytes} bytes — the whole file was buffered`,
        );
    } finally { restore(); }
});

// ── Failure paths ─────────────────────────────────────────────────────────────────────────────

await check('surfaces a session-open rejection without uploading bytes', async () => {
    const video = makeVideo(4096);
    const { state, restore } = installFake({ video, initStatus: 403 });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO);
        assert.strictEqual(outcome.kind, 'failed');
        assert.strictEqual(outcome.kind === 'failed' ? outcome.status : null, 403);
        assert.match(outcome.kind === 'failed' ? outcome.error : '', /Daily upload limit/);
        assert.strictEqual(state.received.length, 0, 'must not upload bytes after a failed session open');
    } finally { restore(); }
});

await check('fails an unreachable source without opening a session', async () => {
    // An expired presign shouldn't burn a slot against the channel's daily upload quota.
    const video = makeVideo(4096);
    const { state, restore } = installFake({ video, sourceStatus: 403 });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO);
        assert.strictEqual(outcome.kind, 'failed');
        assert.match(outcome.kind === 'failed' ? outcome.error : '', /Could not fetch the video/);
        assert.strictEqual(state.sessionsOpened, 0, 'must not open a session for a dead source');
    } finally { restore(); }
});

await check('rejects a post with no video attached', async () => {
    const outcome = await publishYouTubeResumable(META, 'token', null);
    assert.strictEqual(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.error : '', /require a video/);
});

await check('declares the media type and length on the session-open request', async () => {
    const video = makeVideo(300 * 1024);
    const { state, restore } = installFake({ video });
    try {
        await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        // The chunked path has no single PUT to carry Content-Type, so it must ride on init.
        assert.strictEqual(state.uploadContentType, 'video/mp4');
        assert.strictEqual(state.uploadContentLength, String(video.length));
    } finally { restore(); }
});

// ── Resume across invocations: the wall-clock fix ─────────────────────────────────────────────

await check('hands back a resumable session when the budget is already spent', async () => {
    const video = makeVideo(1024 * 1024);
    const { state, restore } = installFake({ video });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, {
            chunkSize: CHUNK,
            deadlineMs: Date.now() - 1,   // already past → stop before sending, after opening
        });
        assert.strictEqual(outcome.kind, 'incomplete');
        if (outcome.kind !== 'incomplete') return;
        assert.strictEqual(outcome.state.uploadUrl, SESSION_URL, 'must hand back the session to resume into');
        assert.strictEqual(outcome.state.total, video.length);
        assert.strictEqual(outcome.state.offset, 0);
        assert.strictEqual(state.received.length, 0);
    } finally { restore(); }
});

await check('a resumed invocation finishes the upload byte-identically', async () => {
    const video = makeVideo(1024 * 1024);
    const { state, restore } = installFake({ video });
    try {
        const first = await publishYouTubeResumable(META, 'token', VIDEO, {
            chunkSize: CHUNK, deadlineMs: Date.now() - 1,
        });
        assert.strictEqual(first.kind, 'incomplete');
        if (first.kind !== 'incomplete') return;

        const second = await publishYouTubeResumable(META, 'token', VIDEO, {
            chunkSize: CHUNK, resume: first.state,
        });
        assert.strictEqual(second.kind, 'done', second.kind === 'failed' ? second.error : '');
        assert.ok(state.received.equals(video), 'the resumed upload produced different bytes');
        assert.strictEqual(state.sessionsOpened, 1, 'a resume must reuse the session, not open a second one');
    } finally { restore(); }
});

await check('a resume trusts the session over the offset it was handed', async () => {
    // The invocation that parked the state can die after YouTube stored a chunk but before the
    // write lands, so the stored offset may lag reality. Replaying those bytes would misalign
    // every subsequent Content-Range.
    const video = makeVideo(1024 * 1024);
    const { state, restore } = installFake({ video });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, {
            chunkSize: CHUNK,
            resume: { uploadUrl: SESSION_URL, total: video.length, offset: 768 * 1024 },
        });
        assert.strictEqual(outcome.kind, 'done', outcome.kind === 'failed' ? outcome.error : '');
        assert.ok(state.received.equals(video), 'driver replayed from a stale offset and corrupted the upload');
    } finally { restore(); }
});

await check('reports a dropped session rather than resuming into nothing', async () => {
    const video = makeVideo(512 * 1024);
    const { restore } = installFake({ video, offsetQueryStatus: 404 });
    try {
        const outcome = await publishYouTubeResumable(META, 'token', VIDEO, {
            resume: { uploadUrl: SESSION_URL, total: video.length, offset: 0 },
        });
        assert.strictEqual(outcome.kind, 'failed');
        assert.match(outcome.kind === 'failed' ? outcome.error : '', /session expired/);
    } finally { restore(); }
});

await check('the run-to-completion wrapper returns a DriverResult', async () => {
    // publishYouTube is what the cron and the chat action call; its DriverResult cannot express
    // "partially uploaded", so it must only ever be used without a deadline.
    const video = makeVideo(512 * 1024);
    const { state, restore } = installFake({ video });
    try {
        const res = await publishYouTube(META, 'token', VIDEO);
        assert.ok(res.ok, `expected a completed upload, got: ${!res.ok ? res.error : ''}`);
        assert.strictEqual(res.ok && res.id, 'yt-video-id');
        assert.ok(state.received.equals(video));
    } finally { restore(); }
});

await check('applies the configured default privacy, and honours an explicit override', async () => {
    // YOUTUBE_DEFAULT_PRIVACY is a deliberate, temporary 'private' pending live verification.
    // Asserting against the constant rather than a literal means flipping it back to 'public'
    // does not fail this test — but a caller-supplied override must always win over it.
    const video = makeVideo(300 * 1024);

    const a = installFake({ video });
    try {
        await publishYouTubeResumable(META, 'token', VIDEO, { chunkSize: CHUNK });
        assert.strictEqual(a.state.privacyStatus, YOUTUBE_DEFAULT_PRIVACY, 'unset must use the configured default');
    } finally { a.restore(); }

    for (const want of ['private', 'public', 'unlisted'] as const) {
        const b = installFake({ video });
        try {
            await publishYouTube(META, 'token', VIDEO, { privacyStatus: want });
            assert.strictEqual(b.state.privacyStatus, want, `override '${want}' must reach the API`);
        } finally { b.restore(); }
    }
});

await check('the temporary private default is still in force', async () => {
    // A deliberate tripwire, not a preference. While this holds, scheduled YouTube posts publish
    // PRIVATE and will look broken to a user. It fails the moment someone reverts the constant,
    // which is the prompt to delete this test along with it.
    assert.strictEqual(
        YOUTUBE_DEFAULT_PRIVACY, 'private',
        'YOUTUBE_DEFAULT_PRIVACY changed — if live verification is done, delete this test; if not, put it back',
    );
});

// ── youtubeMetaFromCaption ────────────────────────────────────────────────────────────────────
// Pre-existing behaviour, locked in here because the driver rewrite sits right next to it.

await check('takes the first non-empty caption line as the title', async () => {
    const meta = youtubeMetaFromCaption('Launch day is here\n\nFull story below', '#coffee');
    assert.strictEqual(meta.title, 'Launch day is here');
    assert.match(meta.description, /Launch day is here/);
    assert.match(meta.description, /#coffee/);
});

await check('appends the #Shorts marker without exceeding the title cap', async () => {
    const meta = youtubeMetaFromCaption('x'.repeat(200), '', 'shorts');
    assert.match(meta.title, /#Shorts$/);
    assert.ok(meta.title.length <= 100, `title is ${meta.title.length} chars`);
    // Already-marked titles must not be doubled up.
    assert.strictEqual(youtubeMetaFromCaption('Clip #shorts', '', 'shorts').title, 'Clip #shorts');
});

await check('parses tags out of a hashtag blob', async () => {
    assert.deepStrictEqual(youtubeMetaFromCaption('c', '#coffee #roasting').tags, ['coffee', 'roasting']);
    assert.deepStrictEqual(youtubeMetaFromCaption('c', 'coffee, roasting').tags, ['coffee', 'roasting']);
    assert.strictEqual(youtubeMetaFromCaption('c', Array(50).fill('#t').join(' ')).tags.length, 30);
});

await check('falls back to a placeholder title for an empty caption', async () => {
    assert.strictEqual(youtubeMetaFromCaption('', '').title, 'New video');
});

// ── resolvePostVideo ──────────────────────────────────────────────────────────────────────────

/** Minimal drizzle-ish stub: db.select(...).from(...).where(...) resolves to `rows`. */
function stubDb(rows: unknown[]) {
    const chain = { from: () => chain, where: async () => rows };
    return { select: () => chain };
}

await check('resolves the attached video, ignoring image assets', async () => {
    const db = stubDb([
        { assetType: 'image', mimeType: 'image/png', storageKey: null, externalUrl: 'https://img' },
        { assetType: 'video', mimeType: 'video/mp4', storageKey: null, externalUrl: 'https://vid' },
    ]);
    assert.deepStrictEqual(await resolvePostVideo(db, [1, 2]), { url: 'https://vid', mimeType: 'video/mp4' });
});

await check('returns null when the post has no video asset', async () => {
    assert.strictEqual(await resolvePostVideo(stubDb([]), []), null);
    const imagesOnly = stubDb([{ assetType: 'image', storageKey: null, externalUrl: 'https://img' }]);
    assert.strictEqual(await resolvePostVideo(imagesOnly, [1]), null);
});

// Print failures alongside passes: a bare "N passed" line reads as success even when N is short of
// the number of checks, which is exactly how a real failure slipped past once during this work.
console.log(`\n${passed} passed, ${failures} failed\n`);
}

void main();
