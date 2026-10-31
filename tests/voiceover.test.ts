// tests/voiceover.test.ts
// Customer voiceovers (Video Producer plan, Phase 2) — src/lib/tts.ts, generate-voiceover.ts,
// the voiceover credit/task kind, and the post editor panel.
//
// What goes wrong silently if these drift:
//   · a voiceover charged as MUSIC (4 tasks, not 1) — audio and voiceover share a media family
//   · a failed transcription throwing away audio the customer already paid for
//   · word timings invented when the transcription had none (captions on words never spoken)
//   · the voiceover cut to the video's length like library music (a sentence chopped mid-word)
// No network, no database.
//
// Run:  npx tsx tests/voiceover.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    cleanScript, parseWords, spokenDuration, voiceoverCostUsd, isVoiceId, VOICES, VOICEOVER_MAX_CHARS,
    synthesizeSpeech, transcribeWords, TtsError,
} from '../src/lib/tts';
import { creditCostFor, workKindForMedia, tasksForCredits, VOICEOVER_CREDIT_COST } from '../src/utils/ai-credits';
import { MEDIA_KINDS, TASK_WEIGHTS, WORK_KIND_LABELS } from '../src/config/task-weights';
import { voiceoverName } from '../netlify/functions/generate-voiceover';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

async function main() {
    await check('a script is cleaned for speech: no URLs, no markdown, capped', () => {
        assert.strictEqual(cleanScript('**Big** news!  Visit https://example.com/offer  today'), 'Big news! Visit today');
        assert.strictEqual(cleanScript('x'.repeat(5000)).length, VOICEOVER_MAX_CHARS);
        assert.strictEqual(cleanScript(''), '');
    });

    await check('word timings come only from the transcription, in order, never invented', () => {
        const words = parseWords({ words: [{ word: ' world', start: 0.6, end: 1.0 }, { word: 'Hello', start: 0.1, end: 0.5 }, { word: 'x' }, { word: '', start: 1, end: 2 }] });
        assert.deepStrictEqual(words, [{ word: 'Hello', start: 0.1, end: 0.5 }, { word: 'world', start: 0.6, end: 1.0 }]);
        assert.deepStrictEqual(parseWords({}), []);
        assert.deepStrictEqual(parseWords(null), []);
    });

    await check("duration is the audio's own, else the last word's end, else unknown", () => {
        assert.strictEqual(spokenDuration({ duration: 12.345 }, []), 12.35);
        assert.strictEqual(spokenDuration({}, [{ word: 'a', start: 0, end: 3.2 }]), 3.2);
        assert.strictEqual(spokenDuration({}, []), null);
    });

    await check('six labelled voices, no person names in the labels', () => {
        assert.strictEqual(VOICES.length, 6);
        assert.ok(isVoiceId('coral') && !isVoiceId('nope') && !isVoiceId(undefined));
        for (const v of VOICES) assert.ok(!/[A-Z][a-z]+ [A-Z]/.test(v.label), `label reads like a name: ${v.label}`);
    });

    await check('a voiceover is 1 credit and 1 task, never priced as music', () => {
        assert.strictEqual(VOICEOVER_CREDIT_COST, 1);
        assert.strictEqual(creditCostFor('voiceover'), 1);
        assert.strictEqual(workKindForMedia('voiceover', 1), 'ai_voiceover');
        assert.strictEqual(tasksForCredits('voiceover', 1), 1);
        assert.strictEqual(TASK_WEIGHTS.ai_voiceover, 1);
        assert.ok(MEDIA_KINDS.includes('ai_voiceover'), 'the autonomous media cap must count voiceovers');
        assert.ok(WORK_KIND_LABELS.ai_voiceover);
    });

    await check('cost log has a floor and scales with length', () => {
        assert.strictEqual(voiceoverCostUsd(60), '0.021000');
        assert.ok(Number(voiceoverCostUsd(0)) > 0);
        assert.ok(Number(voiceoverCostUsd(null)) > 0);
    });

    await check('the library name is the user’s, else "Voiceover · first words"', () => {
        assert.strictEqual(voiceoverName('  Autumn promo ', 'whatever'), 'Autumn promo');
        assert.strictEqual(voiceoverName('', 'one two three four five six seven'), 'Voiceover · one two three four five six…');
        assert.strictEqual(voiceoverName(undefined, 'short line'), 'Voiceover · short line');
    });

    await check('OpenAI failures are sorted into quota / key / policy / other', async () => {
        const saved = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = 'sk-test';
        const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
        const kind = async (status: number, body: string) => {
            try { await synthesizeSpeech('hi', 'coral', reply(status, body)); return 'ok'; }
            catch (e) { return (e as TtsError).kind; }
        };
        assert.strictEqual(await kind(429, '{"error":{"code":"insufficient_quota"}}'), 'quota');
        assert.strictEqual(await kind(401, ''), 'key');
        assert.strictEqual(await kind(400, 'rejected by safety system'), 'policy');
        assert.strictEqual(await kind(500, 'boom'), 'failed');
        const ok = await synthesizeSpeech('hi', 'coral', (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch);
        assert.strictEqual(ok.byteLength, 3);
        const t = await transcribeWords(Buffer.from([1]), (async () => new Response(JSON.stringify({ duration: 2, words: [{ word: 'Hi', start: 0, end: 0.4 }] }), { status: 200 })) as unknown as typeof fetch);
        assert.deepStrictEqual(t, { words: [{ word: 'Hi', start: 0, end: 0.4 }], durationS: 2 });
        delete process.env.OPENAI_API_KEY;
        await assert.rejects(() => synthesizeSpeech('hi', 'coral'), (e: TtsError) => e.kind === 'not_configured');
        if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    });

    await check('the endpoint holds before speaking, refunds every failure, keeps audio when timings fail', () => {
        const fn = readFileSync(join(root, 'netlify/functions/generate-voiceover.ts'), 'utf8');
        const hold = fn.indexOf("holdCredits(db, { orgId, amount: VOICEOVER_CREDIT_COST, mediaType: 'voiceover' })");
        const speak = fn.indexOf('await makeVoiceoverAsset(');
        assert.ok(hold > 0 && speak > hold, 'credits must be held before OpenAI is called');
        assert.ok(fn.includes("mediaType: 'voiceover', userId });"), 'refunds must name the voiceover kind');
        const helper = readFileSync(join(root, 'src/utils/voiceover-asset.ts'), 'utf8');
        assert.ok(/catch \(err\) \{\s*console\.warn\('\[voiceover-asset\] transcription failed/.test(helper), 'a transcription failure must not lose the audio');
        assert.ok(helper.includes("renderParams: { kind: 'voiceover', voice: args.voice, script: args.script, words }"), 'captions read the words from render_params');
        assert.ok(fn.indexOf('enforcePromptModeration(') < hold, 'moderation before spend');
        const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
        assert.ok(/\[functions\.generate-voiceover\]\s*\n\s*timeout = 26/.test(toml), 'speech + transcription need the 26 s ceiling');
    });

    await check('the editor never bounds a voiceover to the video (it would cut the sentence)', () => {
        const html = readFileSync(join(root, 'workspace.html'), 'utf8');
        const start = html.indexOf('async function _pceGenerateVoice()');
        assert.ok(start > 0);
        const body = html.slice(start, html.indexOf('\nfunction ', start + 10));
        assert.ok(!body.includes('_pceMusicDefaultEnd('), 'a voiceover must play its full length');
        assert.ok(body.includes('_pcePersistAudio(postId)'), 'the voiceover must be saved like any other sound');
        assert.ok(html.includes('data-voice-act="open"'), 'the panel needs its button');
    });

    console.log(`\n${passed} checks passed`);
}

main();
