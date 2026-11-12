// tests/tts-voices.test.ts
// The voiceover voices (src/lib/tts.ts VOICES). An accented voice is an OpenAI voice plus an accent
// line in the delivery note; sending our own id to OpenAI as the voice would fail every voiceover.
// The Videos tab and the onboarding question list the same ids, or a pick would silently fall back
// to the default voice.
//
// Run:  npx tsx tests/tts-voices.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES, OFFERED_VOICES, VOICE_LANGUAGES, DEFAULT_VOICE, isVoiceId, voiceRequest, VOICEOVER_INSTRUCTIONS, synthesizeSpeech, speakVoiceover, elevenLabsVoice, voiceoverCostUsd, transcribeAudio, parseWords, spokenDuration, scribeKeyterms, TRANSCRIBE_USD_PER_MINUTE, voiceConfigured, elevenLabsSpeechCostUsd } from '../src/lib/tts';

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

// ElevenLabs speaks the British woman (picked by ear 2026-11-02); no fallback voice since 2026-11-12.
async function withKeys<T>(keys: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const was: Record<string, string | undefined> = {};
    for (const k of Object.keys(keys)) { was[k] = process.env[k]; if (keys[k] === undefined) delete process.env[k]; else process.env[k] = keys[k]; }
    try { return await fn(); } finally { for (const k of Object.keys(was)) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; } }
}

await check('Pepper and Beth are ElevenLabs; the London man and the legacy six stay OpenAI', () => {
    assert.strictEqual(elevenLabsVoice('british_woman'), '6vIP9mPY4dr6w8krUg01');
    assert.strictEqual(elevenLabsVoice('british_woman_playful'), 'zH7TN9vEZAsEway9xWev');
    assert.strictEqual(elevenLabsVoice('london_man'), null);
    for (const v of VOICES) if (v.legacy) assert.strictEqual(elevenLabsVoice(v.id), null, v.id);
});

await check('the catalogue: unique ids, real languages, a woman and a man per language, a sample per offered voice', () => {
    const ids = VOICES.map((v) => v.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate voice id');
    const langs = new Set(VOICE_LANGUAGES.map((l) => l.code));
    for (const v of VOICES) {
        assert.ok(langs.has(v.lang), `${v.id}: unknown language ${v.lang}`);
        assert.ok(v.gender === 'female' || v.gender === 'male', `${v.id}: gender`);
        assert.ok(v.name && v.label, `${v.id}: name and label`);
    }
    for (const l of VOICE_LANGUAGES) {
        const vs = OFFERED_VOICES.filter((v) => v.lang === l.code);
        assert.ok(vs.some((v) => v.gender === 'female') && vs.some((v) => v.gender === 'male'), `${l.label}: needs a woman and a man`);
    }
    // Listening in the picker plays a static file (scripts/make-voice-samples.mjs) — never a fresh voiceover.
    for (const v of OFFERED_VOICES) assert.ok(existsSync(join(root, 'audio/voices', `${v.id}.mp3`)), `no sample for ${v.id} — run scripts/make-voice-samples.mjs`);
    assert.ok(isVoiceId(DEFAULT_VOICE) && !VOICES.find((v) => v.id === DEFAULT_VOICE)!.legacy, 'the default voice is offered');
    // Saved settings from before the catalogue still speak.
    for (const id of ['coral', 'sage', 'verse', 'alloy', 'onyx', 'shimmer']) assert.ok(isVoiceId(id), id);
});

await check('ElevenLabs speaks the British woman when its key is set', async () => {
    const urls: string[] = [];
    const r = await withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () =>
        speakVoiceover('Hello', 'british_woman', (async (u: any) => { urls.push(String(u)); return new Response(new Uint8Array([1])); }) as typeof fetch));
    assert.strictEqual(r.provider, 'elevenlabs');
    assert.strictEqual(urls.length, 1);
    assert.match(urls[0], /api\.elevenlabs\.io\/v1\/text-to-speech\/6vIP9mPY4dr6w8krUg01/);
});

await check('no fallback voice: an ElevenLabs voice that fails or has no key throws, never OpenAI', async () => {
    const urls: string[] = [];
    const failing = (async (u: any) => {
        urls.push(String(u));
        if (String(u).includes('elevenlabs')) return new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 });
        return new Response(new Uint8Array([1]));
    }) as typeof fetch;
    await assert.rejects(() => withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () => speakVoiceover('Hello', 'british_woman', failing)),
        (e: Error & { kind?: string }) => e.kind === 'key');
    await assert.rejects(() => withKeys({ ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: 'oa' }, () => speakVoiceover('Hello', 'british_woman', failing)),
        (e: Error & { kind?: string }) => e.kind === 'not_configured');
    assert.ok(urls.every((u) => !u.includes('api.openai.com')), 'an ElevenLabs voice must never be read by OpenAI');
    assert.ok(!read('src/lib/tts.ts').includes('speaking with OpenAI instead'));
});

await check('a voice counts as available only when its own speaker has a key; the endpoint refuses before holding a credit', async () => {
    await withKeys({ ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: 'oa' }, async () => {
        assert.strictEqual(voiceConfigured('british_woman'), false);
        assert.strictEqual(voiceConfigured('london_man'), true);
    });
    await withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: undefined }, async () => {
        assert.strictEqual(voiceConfigured('british_woman'), true);
        assert.strictEqual(voiceConfigured('london_man'), false);
    });
    const fn = read('netlify/functions/generate-voiceover.ts');
    const refuse = fn.indexOf('if (!voiceConfigured(voice))');
    assert.ok(refuse > 0 && refuse < fn.indexOf('holdCredits(db'), 'refuse before the credit is held');
});

await check('tour narration speaks Pepper through ElevenLabs, never OpenAI, and logs the ElevenLabs cost', () => {
    const fn = read('netlify/functions/tour-narration.ts');
    assert.ok(fn.includes('const VOICE = DEFAULT_VOICE') && fn.includes('synthesizeElevenLabs(text, elevenVoice)'));
    assert.ok(fn.includes('elevenLabsSpeechCostUsd(text.length)'));
    const code = fn.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!code.includes('api.openai.com') && !code.includes('OPENAI_API_KEY') && !code.includes('gpt-4o-mini-tts'));
    assert.strictEqual(elevenLabsSpeechCostUsd(1000), '0.150000');
});

await check('OpenAI voices never call ElevenLabs, and ElevenLabs is costed per character', async () => {
    const urls: string[] = [];
    const r = await withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () =>
        speakVoiceover('Hello', 'london_man', (async (u: any) => { urls.push(String(u)); return new Response(new Uint8Array([1])); }) as typeof fetch));
    assert.strictEqual(r.provider, 'openai');
    assert.ok(urls.every((u) => !u.includes('elevenlabs')));
    // 1,000 characters at $0.15 + one minute of whisper at $0.006, or of Scribe at $0.20/hour, or none when it failed.
    assert.strictEqual(voiceoverCostUsd(60, { provider: 'elevenlabs', chars: 1000 }), '0.156000');
    assert.strictEqual(voiceoverCostUsd(60, { provider: 'elevenlabs', chars: 1000 }, 'elevenlabs'), '0.153333');
    assert.strictEqual(voiceoverCostUsd(60, { provider: 'elevenlabs', chars: 1000 }, null), '0.150000');
    assert.ok(TRANSCRIBE_USD_PER_MINUTE.elevenlabs < TRANSCRIBE_USD_PER_MINUTE.openai);
    assert.strictEqual(voiceoverCostUsd(60, { provider: 'openai', chars: 1000 }), voiceoverCostUsd(60));
});

await check('Scribe words: only type "word" counts, text becomes the word, its duration is read', () => {
    const payload = { audio_duration_secs: 4.567, words: [
        { text: 'Hello', start: 0.1, end: 0.4, type: 'word' }, { text: ' ', start: 0.4, end: 0.5, type: 'spacing' },
        { text: '(laughter)', start: 0.5, end: 0.9, type: 'audio_event' }, { text: 'um', start: 1.0, end: 1.2, type: 'word' },
    ] };
    const words = parseWords(payload);
    assert.deepStrictEqual(words, [{ word: 'Hello', start: 0.1, end: 0.4 }, { word: 'um', start: 1.0, end: 1.2 }]);
    assert.strictEqual(spokenDuration(payload, words), 4.57);
});

await check('word timings: Scribe first (verbatim, no event tags, language + keyterms), whisper only when Scribe refuses', async () => {
    const calls: Array<{ url: string; form: FormData }> = [];
    const scribeOk = (async (u: any, init: any) => {
        calls.push({ url: String(u), form: init.body });
        return new Response(JSON.stringify({ audio_duration_secs: 2, words: [{ text: 'Hi', start: 0, end: 0.4, type: 'word' }] }), { status: 200 });
    }) as typeof fetch;
    const t = await withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () =>
        transcribeAudio(Buffer.from([1]), { filename: 'f.wav', type: 'audio/wav', language: 'en', prompt: 'Umm', keyterms: ['Love Cat', '', 'Love Cat', 'x'.repeat(60)] }, scribeOk));
    assert.deepStrictEqual(t, { words: [{ word: 'Hi', start: 0, end: 0.4 }], durationS: 2, provider: 'elevenlabs' });
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].url, /api\.elevenlabs\.io\/v1\/speech-to-text$/);
    const f = calls[0].form;
    assert.strictEqual(f.get('language_code'), 'en');
    assert.strictEqual(f.get('timestamps_granularity'), 'word');
    assert.strictEqual(f.get('tag_audio_events'), 'false');
    assert.strictEqual(f.get('no_verbatim'), 'false');
    assert.deepStrictEqual(f.getAll('keyterms'), ['Love Cat']);
    assert.strictEqual(f.get('prompt'), null, 'Scribe takes no prompt');

    // Refused (e.g. the key lacks Speech to Text) → whisper, with its prompt.
    const urls: string[] = [];
    let whisperForm: FormData | null = null;
    const refused = (async (u: any, init: any) => {
        urls.push(String(u));
        if (String(u).includes('elevenlabs')) return new Response('{"detail":{"status":"missing_permissions"}}', { status: 401 });
        whisperForm = init.body;
        return new Response(JSON.stringify({ duration: 3, words: [{ word: 'Hi', start: 0, end: 0.4 }] }), { status: 200 });
    }) as typeof fetch;
    const w = await withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () =>
        transcribeAudio(Buffer.from([1]), { filename: 'f.wav', type: 'audio/wav', prompt: 'Umm' }, refused));
    assert.strictEqual(w.provider, 'openai');
    assert.strictEqual(w.durationS, 3);
    assert.strictEqual(urls.length, 2);
    assert.strictEqual((whisperForm as unknown as FormData).get('model'), 'whisper-1');
    assert.strictEqual((whisperForm as unknown as FormData).get('prompt'), 'Umm');

    // No ElevenLabs key → whisper straight away; no OpenAI key → Scribe's error stands.
    const onlyOpenAi = await withKeys({ ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: 'oa' }, () =>
        transcribeAudio(Buffer.from([1]), { filename: 'f.wav', type: 'audio/wav' }, refused));
    assert.strictEqual(onlyOpenAi.provider, 'openai');
    await assert.rejects(() => withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: undefined }, () =>
        transcribeAudio(Buffer.from([1]), { filename: 'f.wav', type: 'audio/wav' }, refused)), (e: Error & { kind?: string }) => e.kind === 'key');

    // A Scribe timeout is not retried on whisper (a second wait could outlast the request).
    const slow: string[] = [];
    const timeout = (async (u: any) => { slow.push(String(u)); const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }) as typeof fetch;
    await assert.rejects(() => withKeys({ ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'oa' }, () =>
        transcribeAudio(Buffer.from([1]), { filename: 'f.wav', type: 'audio/wav' }, timeout)));
    assert.strictEqual(slow.length, 1);
});

await check('Scribe keyterms are clean single lines, 1–50 characters, no repeats, at most 20', () => {
    assert.deepStrictEqual(scribeKeyterms(['  Love\nCat ','<b>', 7, 'Love Cat', '']), ['Love Cat', 'b']);
    assert.strictEqual(scribeKeyterms(Array.from({ length: 30 }, (_, i) => 't' + i)).length, 20);
    assert.deepStrictEqual(scribeKeyterms(undefined), []);
});

await check('the voiceover cost line is told who transcribed it; footage review gives Scribe the business name', () => {
    const src = read('src/utils/voiceover-asset.ts');
    assert.ok(src.includes('provider: transcribedBy } = await transcribeWords(') && src.includes('chars: args.script.length }, transcribedBy)'));
    assert.ok(read('src/utils/footage-review.ts').includes('keyterms: ctx.businessName ? [ctx.businessName] : []'));
});

await check('the voiceover asset records who spoke it', () => {
    const src = read('src/utils/voiceover-asset.ts');
    assert.ok(src.includes('speakVoiceover(') && !src.includes("provider: 'openai'"), 'voiceover-asset must use speakVoiceover and its provider');
});

await check('every screen chooses voices from the catalogue, never a list of its own', () => {
    const tab = read('src/components/assistant-videos.js');
    const onboarding = read('src/public/assistant-onboarding-schemas.js');
    const editor = read('workspace.html');
    assert.ok(!tab.includes("['coral', 'Warm and friendly']"), 'Videos tab must not carry its own voice list');
    assert.ok(tab.includes('VoicePicker?.open('), 'Videos tab opens the voice picker');
    assert.ok(/key: 'defaultVoice',[\s\S]{0,400}picker: 'voice'/.test(onboarding), 'setup asks for the voice with the picker');
    assert.ok(!editor.includes('<select id="insp-voice-voice"'), 'post editor must not carry its own voice list');
    assert.ok(editor.includes("window.VoicePicker?.open({"), 'post editor opens the voice picker');
    assert.ok(read('src/components/voice-picker.js').includes("'/src/public/voice-catalogue.json'"), 'the picker reads the one catalogue');
    assert.ok(!read('assistants.js').includes('new SpeechSynthesisUtterance'), 'Read aloud must not use the browser’s robotic speech');
});

console.log(`\n${passed} checks passed`);
})();
