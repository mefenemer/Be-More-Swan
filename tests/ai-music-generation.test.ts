// tests/ai-music-generation.test.ts
// "✨ Generate music" — Stable Audio 3.0, called direct, paid from the plan's AI credits.
//
// What is proved here, and why each matters:
//   • the prompt rules (instrumental only, no named artist) — the part about what a CUSTOMER
//     publishes, and the one that cannot be seen in a preview;
//   • the Stability client against a fake fetch — the wire format is from their OpenAPI, not from
//     a call we have made, so it is pinned rather than trusted;
//   • the money: credits held before spend, refunded on every failure, and the job recorded
//     BEFORE Stability is asked to start anything;
//   • the migration widens three lists without dropping a single value they already allowed, and
//     runs after the files that define those lists;
//   • the editor attaches a generated track through the same rules as a library one.
//
// Run:  npx tsx tests/ai-music-generation.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    buildMusicPrompt, clampMusicDuration, musicLabel, MUSIC_MOODS, MUSIC_PACES, MUSIC_MIN_S, MUSIC_MAX_S,
} from '../src/lib/music-prompt';
import { extFromMime } from '../src/lib/media-persist';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>): void {
    const run = async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    };
    pending.push(pending.length ? pending[pending.length - 1].then(run) : run());
}

/** The source between two markers; the first must be unique. Throws rather than slicing from -1. */
function slice(src: string, from: string, to: string): string {
    const a = src.indexOf(from);
    assert.notStrictEqual(a, -1, `marker missing: ${from}`);
    assert.strictEqual(src.indexOf(from, a + 1), -1, `marker not unique: ${from}`);
    const b = src.indexOf(to, a + 1);
    assert.ok(b > a, `end marker missing after ${from}: ${to}`);
    return src.slice(a, b);
}

console.log('\nthe prompt rules');

check('every prompt asks for instrumental music', () => {
    const r = buildMusicPrompt({ mood: 'chill', pace: 'slow', durationS: 20 });
    assert.ok(r.ok);
    if (r.ok) {
        assert.ok(/instrumental, no vocals/.test(r.prompt), r.prompt);
        // Last, so nothing the user typed comes after it.
        assert.ok(r.prompt.trim().endsWith('clean mix'), r.prompt);
        assert.ok(r.prompt.includes('slow tempo'), 'the pace is lost');
    }
});

check('the user\'s own words lead the prompt', () => {
    const r = buildMusicPrompt({ description: 'warm acoustic guitar and soft piano', mood: 'inspiring' });
    assert.ok(r.ok && r.prompt.startsWith('warm acoustic guitar and soft piano'));
});

check('asking for an imitation is refused, with a reason', () => {
    for (const d of [
        'in the style of Coldplay', 'a song that sounds like Daft Punk', 'similar to Blinding Lights',
        'piano like Ludovico Einaudi', 'a remix of Levitating', 'inspired by Hans Zimmer',
        'something like The Weeknd', 'style of 80s synthwave artists',
    ]) {
        const r = buildMusicPrompt({ description: d, mood: 'upbeat' });
        assert.ok(!r.ok, `not refused: ${d}`);
        if (!r.ok) assert.ok(/artist or song/.test(r.error), r.error);
    }
});

check('a description that merely uses "like" is not an imitation', () => {
    for (const d of ['soft like rain on a window', 'drums that feel like a heartbeat', 'bright brass, likeable and fun']) {
        assert.ok(buildMusicPrompt({ description: d }).ok, `wrongly refused: ${d}`);
    }
});

check('vocals and lyrics are refused — the model only makes instrumentals', () => {
    for (const d of ['with female vocals', 'add some lyrics about coffee', 'a choir singing', 'rap over a beat']) {
        const r = buildMusicPrompt({ description: d, mood: 'upbeat' });
        assert.ok(!r.ok && /instrumental/.test(r.error), `not refused: ${d}`);
    }
});

check('something to go on is required; junk mood and pace are ignored, not passed on', () => {
    assert.ok(!buildMusicPrompt({}).ok);
    assert.ok(!buildMusicPrompt({ mood: 'nonsense' }).ok, 'an unknown mood counts as a choice');
    const r = buildMusicPrompt({ description: 'harp', mood: 'x', pace: 'y' });
    assert.ok(r.ok && !/undefined|null/.test(r.prompt));
    assert.ok(!buildMusicPrompt({ description: 'a'.repeat(401) }).ok, 'no length limit');
});

check('the length is clamped to our bounds, inside Stability\'s', () => {
    assert.strictEqual(clampMusicDuration(2), MUSIC_MIN_S);
    assert.strictEqual(clampMusicDuration(9999), MUSIC_MAX_S);
    assert.strictEqual(clampMusicDuration('14.4'), 14);
    assert.strictEqual(clampMusicDuration(undefined), 30);
    assert.ok(MUSIC_MAX_S <= 380, 'past Stability\'s own maximum');
});

check('a generated track gets a readable name', () => {
    assert.strictEqual(musicLabel('upbeat, bright, energetic. fast tempo'), 'AI music — upbeat, bright, energetic');
    assert.ok(musicLabel('x'.repeat(80)).endsWith('…'));
    assert.strictEqual(musicLabel(''), 'AI music — generated track');
});

console.log('\nthe Stability client (fake fetch, real wire format)');

check('submit sends multipart to the async 3.0 endpoint and returns the id', async () => {
    process.env.STABILITY_API_KEY = 'test-key';
    const seen: { url: string; init: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify({ id: 'gen_123' }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as any;
    try {
        const { submitMusic } = await import('../src/lib/stability-audio');
        const r = await submitMusic({ prompt: 'p', durationS: 14 });
        assert.strictEqual(r.id, 'gen_123');
        assert.strictEqual(seen[0].url, 'https://api.stability.ai/v2beta/audio/stable-audio/text-to-audio');
        assert.strictEqual(seen[0].init.method, 'POST');
        assert.strictEqual(seen[0].init.headers.authorization, 'Bearer test-key');
        const form = seen[0].init.body as FormData;
        assert.strictEqual(form.get('model'), 'stable-audio-3');
        assert.strictEqual(form.get('duration'), '14');
        assert.strictEqual(form.get('output_format'), 'mp3');
    } finally { globalThis.fetch = realFetch; }
});

check('a moderation refusal is its own error; other failures carry the status', async () => {
    const realFetch = globalThis.fetch;
    const { submitMusic, fetchMusicResult, StabilityPolicyError, StabilityError } = await import('../src/lib/stability-audio');
    try {
        globalThis.fetch = (async () => new Response(JSON.stringify({ errors: ['flagged'] }), { status: 403 })) as any;
        await assert.rejects(submitMusic({ prompt: 'p', durationS: 10 }), (e: unknown) => e instanceof StabilityPolicyError);
        globalThis.fetch = (async () => new Response(JSON.stringify({ errors: ['slow down'] }), { status: 429 })) as any;
        await assert.rejects(submitMusic({ prompt: 'p', durationS: 10 }),
            (e: unknown) => e instanceof StabilityError && e.status === 429 && /slow down/.test(e.message));
        // An expired result is a 404 the worker must recognise.
        globalThis.fetch = (async () => new Response('{}', { status: 404 })) as any;
        await assert.rejects(fetchMusicResult('gen_1'), (e: unknown) => e instanceof StabilityError && e.status === 404);
    } finally { globalThis.fetch = realFetch; }
});

check('a result is "not yet" on 202 and the bytes on 200', async () => {
    const realFetch = globalThis.fetch;
    const { fetchMusicResult } = await import('../src/lib/stability-audio');
    try {
        let accept = '';
        globalThis.fetch = (async (_u: any, init: any) => {
            accept = init.headers.accept;
            return new Response(JSON.stringify({ id: 'g', status: 'in-progress' }), { status: 202 });
        }) as any;
        assert.deepStrictEqual(await fetchMusicResult('g'), { done: false });
        assert.strictEqual(accept, 'audio/*', 'asks for JSON/base64 instead of the bytes');
        globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]),
            { status: 200, headers: { 'content-type': 'audio/mpeg', seed: '42' } })) as any;
        const r = await fetchMusicResult('g');
        assert.ok(r.done && r.bytes.byteLength === 3 && r.contentType === 'audio/mpeg' && r.seed === '42');
    } finally { globalThis.fetch = realFetch; }
});

console.log('\nthe money');

const fn = read('netlify/functions/generate-ai-music.ts');
const worker = read('netlify/functions/process-music-job-background.ts');
const credits = read('src/utils/ai-credits.ts');

check('rules and moderation run before credits are held, and credits before anything is started', () => {
    const post = fn.slice(fn.indexOf("if (event.httpMethod !== 'POST')"));
    const at = (s: string) => { const i = post.indexOf(s); assert.notStrictEqual(i, -1, `missing: ${s}`); return i; };
    assert.ok(at('buildMusicPrompt(body)') < at('enforcePromptModeration('), 'moderation before our own rules');
    assert.ok(at('enforcePromptModeration(') < at('holdCredits('), 'credits held before moderation');
    // ⚠️ The job row BEFORE Stability is called — or a failed insert leaves a paid generation running
    // that nothing here knows about.
    assert.ok(at('db.insert(mediaGenerationJobs)') < at('submitMusic('), 'Stability is called before the job is recorded');
});

check('every failure path in the request refunds the hold', () => {
    const post = fn.slice(fn.indexOf('holdCredits('));
    // insert failure, submit failure (via failJob), policy refusal (via failJob)
    assert.ok((post.match(/success: false/g) || []).length >= 2, 'a failure path keeps the credits');
    assert.ok(post.includes("await failJob('Stability declined that description.', 'flagged')"));
});

check('the worker settles as audio, and refunds on every failure', () => {
    assert.ok(worker.includes("success: true, mediaType: 'audio'"), 'success is not settled as audio');
    const failFn = slice(worker, 'async function fail(', '\n    }');
    assert.ok(failFn.includes("success: false, mediaType: 'audio'"), 'a failure is not refunded');
    // Stability's results expire, so the bytes must be stored before anything else.
    assert.ok(worker.indexOf('persistBufferToR2(') < worker.indexOf('db.insert(contentAssets)'));
    assert.ok(worker.indexOf('db.insert(contentAssets)') < worker.indexOf("success: true, mediaType: 'audio'"),
        'charged before the asset exists');
});

check('an audio settle is ledgered as music_generation', () => {
    assert.ok(credits.includes("params.mediaType === 'audio' ? 'music_generation'"));
    assert.ok(/export const MUSIC_CREDIT_COST = \d+;/.test(credits));
});

check('a generated mp3 is stored as .mp3, not .png', () => {
    assert.strictEqual(extFromMime('audio/mpeg'), 'mp3');
    assert.strictEqual(extFromMime('audio/wav'), 'wav');
    assert.strictEqual(extFromMime('audio/mp4'), 'm4a');
    assert.strictEqual(extFromMime('video/mp4'), 'mp4', 'video regressed');
    assert.strictEqual(extFromMime('image/png'), 'png', 'images regressed');
});

console.log('\nthe migration');

const mig = read('db/z-ai-music-generation.sql');
const listIn = (sql: string, name: string): string[] => {
    const at = sql.lastIndexOf(`CONSTRAINT ${name}`);
    assert.notStrictEqual(at, -1, `${name} not defined`);
    const body = sql.slice(at, sql.indexOf(')', sql.indexOf('IN (', at)) + 1);
    return Array.from(body.matchAll(/'([^']+)'/g), (m) => m[1]);
};

check('every value the old lists allowed is still allowed', () => {
    const pairs: [string, string][] = [
        ['db/media-generation.sql', 'media_generation_jobs_media_type_check'],
        ['db/media-generation.sql', 'media_generation_jobs_aspect_check'],
        ['db/x-credit-packs.sql', 'ai_credit_ledger_reason_check'],
    ];
    for (const [file, name] of pairs) {
        const before = listIn(read(file), name);
        const after = listIn(mig, name);
        for (const v of before) assert.ok(after.includes(v), `${name} drops '${v}'`);
    }
    assert.ok(listIn(mig, 'media_generation_jobs_media_type_check').includes('audio'));
    assert.ok(listIn(mig, 'media_generation_jobs_aspect_check').includes('none'));
    assert.ok(listIn(mig, 'ai_credit_ledger_reason_check').includes('music_generation'));
});

check('it runs after every file that defines those lists', () => {
    // The runner applies db/*.sql alphabetically; on a fresh database an earlier name would be
    // undone by whichever redefinition ran next.
    const files = readdirSync(join(root, 'db')).filter((f) => f.endsWith('.sql')).sort();
    const mine = files.indexOf('z-ai-music-generation.sql');
    for (const f of files) {
        if (f === 'z-ai-music-generation.sql') continue;
        const sql = read(`db/${f}`);
        if (/ai_credit_ledger_reason_check|media_generation_jobs_(media_type|aspect)_check/.test(sql)) {
            assert.ok(files.indexOf(f) < mine, `${f} runs after the widening and would undo it`);
        }
    }
});

check('no new column — the video worker selects every column of the jobs table', () => {
    assert.ok(!/ADD COLUMN/i.test(mig), 'a new column breaks process-media-job-background until applied');
});

console.log('\nthe editor');

const ws = read('workspace.html');

check('the panel offers exactly the moods and paces the server accepts', () => {
    const moods = slice(ws, 'const _PCE_GEN_MOODS = [', ']');
    const paces = slice(ws, 'const _PCE_GEN_PACES = [', ']');
    assert.deepStrictEqual(Array.from(moods.matchAll(/'([a-z]+)'/g), (m) => m[1]), [...MUSIC_MOODS]);
    assert.deepStrictEqual(Array.from(paces.matchAll(/'([a-z]+)'/g), (m) => m[1]), [...MUSIC_PACES]);
});

check('a generated track is attached by the same rules as a library one', () => {
    const attach = slice(ws, 'async function _pceAttachGeneratedTrack(postId, job, target) {', '\nasync function _pceRemoveAudio(');
    assert.ok(attach.includes('_pcePlaceNewSound(post, clip)'), 'ignores the clip it was asked for on');
    assert.ok(attach.includes('_pceMusicDefaultEnd(post, clip)'), 'can stretch the video like an unbounded bed');
    assert.ok(attach.includes('_pcePersistAudio(postId)'), 'saves the open post instead of the one it was made for');
});

check('the length asked for is the video\'s, from where the sound will start', () => {
    const len = slice(ws, 'function _pceGenMusicLength(post) {', '\n}');
    assert.ok(len.includes('_pceClipsTotalS(post)') && len.includes('end - start'));
    assert.ok(len.includes('Math.min(190, Math.max(6,'), 'out of step with MUSIC_MIN_S / MUSIC_MAX_S');
    assert.strictEqual(MUSIC_MIN_S, 6); assert.strictEqual(MUSIC_MAX_S, 190);
});

check('the panel binds at load, on document — not from a render path', () => {
    assert.ok(ws.includes('(function _pceBindGenMusicOnce() {'));
    assert.ok(slice(ws, '(function _pceBindGenMusicOnce() {', '})();').includes("document.addEventListener('click'"));
});

Promise.all(pending).then(() => console.log(`\n${passed} checks passed`));
