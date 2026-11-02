// tests/tts-voices.test.ts
// The voiceover voices (src/lib/tts.ts VOICES). An accented voice is an OpenAI voice plus an accent
// line in the delivery note; sending our own id to OpenAI as the voice would fail every voiceover.
// The Videos tab and the onboarding question list the same ids, or a pick would silently fall back
// to the default voice.
//
// Run:  npx tsx tests/tts-voices.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES, voiceRequest, VOICEOVER_INSTRUCTIONS, synthesizeSpeech, speakVoiceover, elevenLabsVoice, voiceoverCostUsd } from '../src/lib/tts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

await check('every voice reaches OpenAI as a real OpenAI voice', () => {
    for (const v of VOICES) assert.ok(OPENAI_VOICES.includes(voiceRequest(v.id).speaker), v.id);
});

await check('the British voices carry their accent; the plain ones the plain delivery note', () => {
    assert.strictEqual(voiceRequest('coral').instructions, VOICEOVER_INSTRUCTIONS);
    assert.match(voiceRequest('british_woman').instructions, /British English accent/);
    assert.match(voiceRequest('london_man').instructions, /London accent/);
    assert.strictEqual(voiceRequest('london_man').speaker, 'ballad');
});

await check('the request body sends the OpenAI voice and the accent', async () => {
    const was = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test';
    let body: any = null;
    try {
        await synthesizeSpeech('Hello', 'london_man', (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(new Uint8Array([1])); }) as typeof fetch);
    } finally { if (was === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = was; }
    assert.strictEqual(body.voice, 'ballad');
    assert.match(body.instructions, /London accent/);
});

// ElevenLabs speaks the British woman (picked by ear 2026-11-02); OpenAI is only her fallback.
async function withKeys<T>(keys: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const was: Record<string, string | undefined> = {};
    for (const k of Object.keys(keys)) { was[k] = process.env[k]; if (keys[k] === undefined) delete process.env[k]; else process.env[k] = keys[k]; }
    try { return await fn(); } finally { for (const k of Object.keys(was)) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; } }
}

await check('the British woman is ElevenLabs Pepper; every other voice stays OpenAI', () => {
    assert.strictEqual(elevenLabsVoice('british_woman'), '6vIP9mPY4dr6w8krUg01');
    for (const v of VOICES) if (v.id !== 'british_woman') assert.strictEqual(elevenLabsVoice(v.id), null, v.id);
});

await check('ElevenLabs speaks the British woman when its key is set', async () => {
    const urls: string[] = [];
    const r = await withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () =>
        speakVoiceover('Hello', 'british_woman', (async (u: any) => { urls.push(String(u)); return new Response(new Uint8Array([1])); }) as typeof fetch));
    assert.strictEqual(r.provider, 'elevenlabs');
    assert.strictEqual(urls.length, 1);
    assert.match(urls[0], /api\.elevenlabs\.io\/v1\/text-to-speech\/6vIP9mPY4dr6w8krUg01/);
});

await check('an ElevenLabs failure or missing key falls back to OpenAI coral with the accent', async () => {
    const bodies: any[] = [];
    const failing = (async (u: any, init: any) => {
        if (String(u).includes('elevenlabs')) return new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 });
        bodies.push(JSON.parse(init.body)); return new Response(new Uint8Array([1]));
    }) as typeof fetch;
    const failed = await withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () => speakVoiceover('Hello', 'british_woman', failing));
    const unset = await withKeys({ ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: 'oa' }, () => speakVoiceover('Hello', 'british_woman', failing));
    assert.deepStrictEqual([failed.provider, unset.provider], ['openai', 'openai']);
    assert.strictEqual(bodies.length, 2);
    assert.strictEqual(bodies[0].voice, 'coral');
    assert.match(bodies[0].instructions, /British English accent/);
});

await check('OpenAI voices never call ElevenLabs, and ElevenLabs is costed per character', async () => {
    const urls: string[] = [];
    const r = await withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () =>
        speakVoiceover('Hello', 'london_man', (async (u: any) => { urls.push(String(u)); return new Response(new Uint8Array([1])); }) as typeof fetch));
    assert.strictEqual(r.provider, 'openai');
    assert.ok(urls.every((u) => !u.includes('elevenlabs')));
    // 1,000 characters at $0.15 + one minute of whisper at $0.006.
    assert.strictEqual(voiceoverCostUsd(60, { provider: 'elevenlabs', chars: 1000 }), '0.156000');
    assert.strictEqual(voiceoverCostUsd(60, { provider: 'openai', chars: 1000 }), voiceoverCostUsd(60));
});

await check('the voiceover asset records who spoke it', () => {
    const src = read('src/utils/voiceover-asset.ts');
    assert.ok(src.includes('speakVoiceover(') && !src.includes("provider: 'openai'"), 'voiceover-asset must use speakVoiceover and its provider');
});

await check('the Videos tab and the onboarding question offer the same voices', () => {
    const tab = read('src/components/assistant-videos.js');
    const onboarding = read('src/public/assistant-onboarding-schemas.js');
    for (const v of VOICES) {
        assert.ok(tab.includes(`['${v.id}', '${v.label}']`), `Videos tab: ${v.id}`);
        assert.ok(onboarding.includes(`{ value: '${v.id}', label: '${v.label}' }`), `onboarding: ${v.id}`);
    }
});

console.log(`\n${passed} checks passed`);
})();
