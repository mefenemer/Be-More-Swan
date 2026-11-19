// tests/voiceover-at-length.test.ts
// Phase 4c-1 (docs/video-producer-screen-walkthrough-plan.md §12, "4c design"): a long video's voiceover. The script
// may run to 10,000 characters, is spoken in parts at sentence boundaries and joined into one clean MP3, and the
// waits for speech and word timings scale with length. Short voiceovers are exactly as before: one call, 12 s.
//
// Run:  npx tsx tests/voiceover-at-length.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    cleanScript, splitForSpeech, speechTimeoutMs, transcribeTimeoutMs, speakVoiceover,
    VOICEOVER_MAX_CHARS, LONG_VOICEOVER_MAX_CHARS, SPEECH_PART_CHARS, type VoiceId,
} from '../src/lib/tts';
import { id3Length, frameLength, mp3Frames, joinMp3 } from '../src/lib/mp3-join';
import { maxLineChars } from '../src/lib/storyboard';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// A Layer III frame as ElevenLabs sends it: MPEG1, 128 kbps, 44.1 kHz, no padding = 417 bytes.
const HEADER = [0xff, 0xfb, 0x90, 0xc0];
const frame = (fill: number) => Buffer.concat([Buffer.from(HEADER), Buffer.alloc(413, fill)]);
const infoFrame = () => { const f = frame(0); f.write('Info', 4 + 32, 'latin1'); return f; };
const id3 = () => Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0x22]), Buffer.alloc(0x22, 0)]);
const part = (fill: number, frames = 3) => Buffer.concat([id3(), infoFrame(), ...Array.from({ length: frames }, () => frame(fill))]);

(async () => {
    console.log('splitting and limits');

    await check('a long script splits at sentences, never past the part size, and joins back to the whole', () => {
        const sentence = 'We film each line a few times, and we only keep the best take. ';
        const script = sentence.repeat(200).trim();   // ~12,600 characters
        const parts = splitForSpeech(script);
        assert.ok(parts.length >= 5);
        for (const p of parts) {
            assert.ok(p.length <= SPEECH_PART_CHARS, `a part of ${p.length}`);
            assert.ok(/[.!?]$/.test(p), `a part ends mid-sentence: …${p.slice(-20)}`);
        }
        assert.strictEqual(parts.join(' '), script);
        assert.deepStrictEqual(splitForSpeech('Short line.'), ['Short line.']);
        assert.deepStrictEqual(splitForSpeech(''), []);
        // No sentence end in reach: a comma, then a space.
        const run = ('word, '.repeat(800)).trim();
        assert.ok(splitForSpeech(run).every((p) => p.length <= SPEECH_PART_CHARS));
    });

    await check('the script cap: 1200 characters by default, 10,000 when the caller asks (a long video)', () => {
        const long = 'a'.repeat(12_000);
        assert.strictEqual(cleanScript(long).length, VOICEOVER_MAX_CHARS);
        assert.strictEqual(cleanScript(long, LONG_VOICEOVER_MAX_CHARS).length, LONG_VOICEOVER_MAX_CHARS);
        assert.match(read('src/utils/video-producer.ts'), /cleanScript\(scriptOf\(storyboard\), isLongLength\(brief\.lengthS\) \? LONG_VOICEOVER_MAX_CHARS : VOICEOVER_MAX_CHARS\)/);
    });

    await check('a scene line: 240 characters, 1200 in a long video (form, chat card and planner)', () => {
        assert.strictEqual(maxLineChars({ lengthS: 30 }), 240);
        assert.strictEqual(maxLineChars({ lengthS: 600 }), 1200);
        assert.match(read('src/lib/storyboard.ts'), /voiceover: lineAtSentence\(o\.voiceover, maxLineChars\(brief\), i, changes\),/, 'cut at a sentence, with a note (review of #761)');
        assert.match(read('src/utils/chat-video-scene.ts'), /const voiceover = str\(ui\.voiceover, 1200\);/);
        assert.match(read('src/components/assistant-videos.js'), /maxlength="\$\{Number\(v\.brief && v\.brief\.lengthS\) >= 120 \? 1200 : 240\}"/);
    });

    await check('waits scale with length; a short voiceover keeps 12 s to speak and 8 s for words', () => {
        assert.strictEqual(speechTimeoutMs(800), 12_000);
        assert.strictEqual(speechTimeoutMs(2400), 12_000 + 1200 * 15);
        assert.strictEqual(transcribeTimeoutMs(300_000), 8_000);
        const tenMinutes = transcribeTimeoutMs(9.6 * 1024 * 1024);
        assert.ok(tenMinutes >= 90_000 && tenMinutes <= 100_000, String(tenMinutes));
        assert.match(read('src/lib/tts.ts'), /timeoutMs: transcribeTimeoutMs\(mp3\.byteLength\)/);
    });

    console.log('joining MP3 parts');

    await check('ID3 tag and Info frame are found and stripped; the frames are kept', () => {
        const p = part(7);
        assert.strictEqual(id3Length(p), 10 + 0x22);
        assert.strictEqual(frameLength(p, id3Length(p)), 417);
        const frames = mp3Frames(p);
        assert.strictEqual(frames.length, 3 * 417, 'the Info frame and tag are gone');
        assert.strictEqual(frames[0], 0xff);
        assert.strictEqual(frames[4], 7, 'the first audio frame comes first');
    });

    await check('parts join into plain frames, in order; one part comes back untouched', () => {
        const joined = joinMp3([part(1), part(2, 2), part(3)]);
        assert.strictEqual(joined.length, (3 + 2 + 3) * 417);
        assert.ok(!joined.includes(Buffer.from('ID3')) && !joined.includes(Buffer.from('Info')));
        assert.deepStrictEqual([0, 3, 5].map((k) => joined[k * 417 + 4]), [1, 2, 3]);
        const one = part(9);
        assert.strictEqual(joinMp3([one]), one);
    });

    console.log('speaking in parts');

    await check('a long script is spoken in parts (3 at a time) and joined; a short one is one call as before', async () => {
        process.env.ELEVENLABS_API_KEY = 'test';
        const voices = JSON.parse(read('src/public/voice-catalogue.json'));
        const eleven = ((voices.voices ?? voices) as Array<{ id: string; elevenlabs?: string }>).find((v) => v.elevenlabs)!;
        const calls: Array<{ chars: number }> = [];
        let inFlight = 0, most = 0;
        const fakeFetch = (async (_url: string, init: { body: string }) => {
            const { text } = JSON.parse(init.body);
            calls.push({ chars: text.length });
            inFlight++; most = Math.max(most, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return new Response(new Uint8Array(part(calls.length)), { status: 200 });
        }) as unknown as typeof fetch;
        const short = await speakVoiceover('Hello there, this is short.', eleven.id as VoiceId, fakeFetch);
        assert.strictEqual(calls.length, 1);
        assert.ok(short.mp3.subarray(0, 3).toString('latin1') === 'ID3', 'one call: the file as it came');
        calls.length = 0;
        const script = 'We film each line a few times, and we only keep the best take. '.repeat(150).trim();
        const long = await speakVoiceover(script, eleven.id as VoiceId, fakeFetch);
        assert.strictEqual(calls.length, splitForSpeech(script).length);
        assert.ok(calls.every((c) => c.chars <= SPEECH_PART_CHARS));
        assert.ok(most <= 3, `${most} at once`);
        assert.strictEqual(long.mp3.length, calls.length * 3 * 417, 'joined plain frames');
        assert.strictEqual(long.provider, 'elevenlabs');
    });

    console.log(`\n${passed} checks passed.`);
})();
