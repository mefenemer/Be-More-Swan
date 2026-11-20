// tests/voice-languages.test.ts
// More voiceover languages, Welsh among them (plan A4, docs/video-producer-screen-walkthrough-plan.md §11.4, 2026-11-20).
//   · Welsh and Norwegian are spoken by eleven_v3: eleven_multilingual_v2 refuses 'cy' (HTTP 400 "does not support
//     language_code 'cy'") and has no Norwegian. No language_code is sent: v3 reads the language from the script, so a
//     Welsh-accented voice still reads an English post in English (review of A4). Every other language: ELEVENLABS_MODEL.
//   · eleven_v3 is slow (1,190 Welsh characters took 31 s, past the voiceover request's 26 s), so its scripts go in parts
//     of at most SLOW_MODEL_PART_CHARS spoken side by side.
//   · A Video Producer build (and an own-voice recording) tells the transcriber the language it was written in (Scribe
//     was only 53% sure Welsh was Welsh); a post's voiceover, in any language, is left to detection.
//   · Caption files are named and translated from the language the video is SPOKEN in, not always English, and English
//     is offered as a translation of a Welsh video.
//
// Run:  npx tsx tests/voice-languages.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { VOICES, OFFERED_VOICES, VOICE_LANGUAGES, ELEVENLABS_MODEL, SLOW_MODEL_PART_CHARS, VOICEOVER_MAX_CHARS, speechModel, speakVoiceover, splitForSpeech, slowModelParts, voicePace } from '../src/lib/tts';
import { CAPTION_LANGUAGES } from '../src/lib/youtube-extras';
import { spokenLanguage } from '../src/utils/youtube-video';
import { translationPrompt, translateCaptions } from '../src/utils/caption-translate';
import { PRESENTERS, presenterLanguages, presenterVoice } from '../src/lib/presenters';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
const NEW = ['cy', 'sv', 'da', 'no', 'fi', 'el', 'cs', 'ro'];

await check('the new languages are in the one voice list, Welsh straight after English, each with a woman and a man', () => {
    const codes = VOICE_LANGUAGES.map((l) => l.code);
    for (const c of NEW) assert.ok(codes.includes(c), c);
    assert.strictEqual(codes[1], 'cy', 'Welsh comes second (UK first)');
    for (const c of NEW) {
        const vs = OFFERED_VOICES.filter((v) => v.lang === c);
        assert.ok(vs.some((v) => v.gender === 'female') && vs.some((v) => v.gender === 'male'), `${c}: a woman and a man`);
        for (const v of vs) assert.ok(existsSync(new URL(`../audio/voices/${v.id}.mp3`, import.meta.url)), `${v.id}: sample`);
    }
});

await check('every offered voice has a measured pace except Japanese (no spaces between words)', () => {
    for (const v of OFFERED_VOICES) {
        if (v.lang === 'ja') assert.strictEqual(voicePace(v.id), null, v.id);
        else assert.ok(voicePace(v.id), `${v.id}: run scripts/measure-voice-pace.mjs --write --only=${v.id}`);
    }
});

await check('Welsh and Norwegian are spoken by eleven_v3; the rest by the default model', () => {
    assert.deepStrictEqual(speechModel('cy_hannah'), { model: 'eleven_v3', languageCode: 'cy' });
    assert.deepStrictEqual(speechModel('cy_chris'), { model: 'eleven_v3', languageCode: 'cy' });
    assert.deepStrictEqual(speechModel('no_mia'), { model: 'eleven_v3', languageCode: 'no' });
    for (const id of ['british_woman', 'fr_adina', 'sv_sanna', 'da_mathias', 'fi_aurora', 'el_eleni', 'cs_jan', 'ro_jora']) {
        assert.deepStrictEqual(speechModel(id), { model: ELEVENLABS_MODEL, languageCode: null }, id);
    }
    assert.deepStrictEqual(VOICE_LANGUAGES.filter((l) => l.model).map((l) => l.code).sort(), ['cy', 'no']);
});

async function spoken(text: string, voice: string) {
    const bodies: any[] = [];
    const was = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'test';
    try {
        const r = await speakVoiceover(text, voice, (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00])); }) as typeof fetch);
        return { r, bodies };
    } finally { if (was === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = was; }
}
const sentence = "Rydyn ni'n gofyn beth rydych chi'n ei wneud a phwy yw eich cwsmeriaid. ";

await check('a Welsh voiceover asks eleven_v3 with no language_code, and the job row records that model', async () => {
    const { r, bodies } = await spoken('Helo, croeso i Gaerdydd.', 'cy_hannah');
    assert.strictEqual(bodies.length, 1);
    assert.strictEqual(bodies[0].model_id, 'eleven_v3');
    assert.ok(!('language_code' in bodies[0]), 'v3 reads the language from the script');
    assert.strictEqual(r.model, 'eleven_v3');
});

await check('an English post on a Welsh voice is not forced into Welsh (review of A4)', async () => {
    const { bodies } = await spoken('Good morning, Cardiff! Here is some sweet news.', 'cy_hannah');
    assert.strictEqual(bodies[0].text, 'Good morning, Cardiff! Here is some sweet news.');
    assert.ok(!('language_code' in bodies[0]));
});

await check('a French voiceover is unchanged: the default model, no language_code (multilingual v2 refuses the field)', async () => {
    const { r, bodies } = await spoken('Bonjour et bienvenue.', 'fr_adina');
    assert.strictEqual(bodies[0].model_id, ELEVENLABS_MODEL);
    assert.ok(!('language_code' in bodies[0]));
    assert.strictEqual(r.model, ELEVENLABS_MODEL);
});

await check('a full-length Welsh voiceover goes in parts of at most 500 characters (one batch of three); an English one stays one call', async () => {
    const text = sentence.repeat(Math.floor(VOICEOVER_MAX_CHARS / sentence.length)).trim();
    assert.ok(text.length > 1100 && text.length <= VOICEOVER_MAX_CHARS);
    const cy = await spoken(text, 'cy_chris');
    assert.strictEqual(cy.bodies.length, 3, `parts: ${cy.bodies.length}`);
    for (const b of cy.bodies) assert.ok(b.text.length <= SLOW_MODEL_PART_CHARS && b.model_id === 'eleven_v3');
    assert.strictEqual(cy.bodies.map((b) => b.text).join(' '), text, 'the parts give the script back');
    const en = await spoken(text, 'british_woman');
    assert.strictEqual(en.bodies.length, 1);
    assert.strictEqual(splitForSpeech(text, SLOW_MODEL_PART_CHARS).length, 3);
});

await check('long sentences never push a short Welsh voiceover into a second batch (review of A4)', async () => {
    // Sentences of ~290 characters: 500-character parts would cut after one sentence each, giving 4–5 parts.
    const long = "Rydyn ni'n gofyn beth rydych chi'n ei wneud, pwy yw eich cwsmeriaid, sut rydych chi am i bobl deimlo, beth sy'n gwneud eich busnes yn wahanol, pa luniau sydd gennych chi'n barod, pa gerddoriaeth rydych chi'n ei hoffi a phryd rydych chi am i'r ffilm fod yn barod i'w rhannu gyda'ch cwsmeriaid i gyd. ";
    const text = long.repeat(4).trim().slice(0, VOICEOVER_MAX_CHARS).replace(/\s+\S*$/, '.');
    assert.ok(splitForSpeech(text, SLOW_MODEL_PART_CHARS).length > 3, 'the case the review found');
    const parts = slowModelParts(text);
    assert.ok(parts.length <= 3, `parts: ${parts.length}`);
    assert.strictEqual(parts.join(' '), text);
    const cy = await spoken(text, 'cy_hannah');
    assert.ok(cy.bodies.length <= 3);
    // A long video's script (background) keeps 500-character parts.
    assert.ok(slowModelParts(text.repeat(3)).every((p) => p.length <= SLOW_MODEL_PART_CHARS));
});

await check('the transcriber is told the language only where the script\'s language is known; the request deadline caps it', () => {
    const src = read('src/utils/voiceover-asset.ts');
    assert.ok(src.includes('transcribeWords(mp3, fetch, args.language ?? null,'));
    assert.ok(src.includes('Math.min(transcribeTimeoutMs(mp3.byteLength), left)'));
    assert.ok(read('src/utils/video-producer.ts').includes('language: spokenLanguage(brief),'), 'the build passes the script language');
    const gv = read('netlify/functions/generate-voiceover.ts');
    assert.ok(gv.includes('makeVoiceoverAsset(db, { orgId, userId, script, voice, name, deadlineAt })') && !/makeVoiceoverAsset\([^)]*language/.test(gv), 'a post voiceover: deadline, no language');
    const vp = read('netlify/functions/video-projects.ts');
    assert.strictEqual(vp.split('language: spokenLanguage(brief) });').length - 1, 2, 'own-voice recordings too');
    assert.ok(!vp.includes('language: brief.language'));
});

await check('the sample and pace scripts speak every language, with the catalogue model', () => {
    const samples = read('scripts/make-voice-samples.mjs'), pace = read('scripts/measure-voice-pace.mjs');
    for (const l of VOICE_LANGUAGES) {
        assert.ok(new RegExp(`\\n    ${l.code}: \\(n\\) =>`).test(samples), `make-voice-samples: a line in ${l.label}`);
        if (l.code !== 'ja') assert.ok(new RegExp(`\\n    ${l.code}: ['"]`).test(pace), `measure-voice-pace: a paragraph in ${l.label}`);
    }
    for (const s of [samples, pace]) assert.ok(s.includes('modelFor(') && !s.includes('language_code'));
});

await check('every presenter can speak Welsh, in a Welsh voice of their gender', () => {
    for (const p of PRESENTERS) {
        assert.ok(presenterLanguages(p).includes('cy'), p.id);
        const v = VOICES.find((x) => x.id === presenterVoice(p, 'cy'))!;
        assert.ok(v && v.lang === 'cy' && v.gender === p.gender, p.id);
    }
});

await check('every voice language has a caption-language name; English is a translation target', () => {
    for (const l of VOICE_LANGUAGES) assert.strictEqual(CAPTION_LANGUAGES[l.code], l.label, l.code);
    assert.strictEqual(CAPTION_LANGUAGES.en, 'English');
});

await check('the language a video is spoken in: the brief\'s, else its voice\'s, else English', () => {
    assert.strictEqual(spokenLanguage({ language: 'cy' }), 'cy');
    assert.strictEqual(spokenLanguage({ voiceover: true, voice: 'cy_chris' }), 'cy');
    assert.strictEqual(spokenLanguage({ voiceover: true, voice: 'no_olaf' }), 'no');
    assert.strictEqual(spokenLanguage({ voiceover: true }), 'en', 'default voice (Pepper)');
    assert.strictEqual(spokenLanguage({ voiceover: false, voice: 'cy_chris' }), 'en', 'own sound, no language set');
    assert.strictEqual(spokenLanguage({ language: 'xx', voiceover: true, voice: 'fr_adina' }), 'fr', 'an unknown language falls through');
    assert.strictEqual(spokenLanguage(null), 'en');
});

await check('captions are translated FROM the language spoken; the spoken one is never offered or charged as a translation', async () => {
    const p = translationPrompt([{ s: 0, e: 1, t: 'Croeso' }] as any, 'English', 'Welsh');
    assert.match(p.system, /from Welsh into English/);
    assert.match(translationPrompt([{ s: 0, e: 1, t: 'Hi' }] as any, 'French').system, /from English into French/);
    // Refused before anything is read or charged: a null db would throw if it were touched.
    const welsh = { status: 'ready', timeline: {}, brief: { voiceover: true, voice: 'cy_hannah' }, organisationId: 58 } as any;
    const r = await translateCaptions(null as any, welsh, 'cy');
    assert.deepStrictEqual(r, { ok: false, status: 400, error: 'This video is already spoken in Welsh.' });
    // An old translation into the spoken language (French video, 'fr' stored) doesn't count toward the 10.
    const tr = read('src/utils/caption-translate.ts');
    assert.ok(tr.includes('const kept = Object.keys(have).filter((c) => c !== spoken);'));
    const ui = read('src/components/assistant-videos.js');
    assert.ok(!ui.includes('English (as spoken)'), 'no hard-coded English');
    assert.ok(ui.includes("const spoken = v.spokenLanguage || 'en';") && ui.includes('c !== spoken);'));
    assert.ok(read('netlify/functions/video-projects.ts').includes('qs.captions === spokenLanguage(row.brief)'));
    assert.ok(read('src/utils/video-producer.ts').includes('spokenLanguage: spokenLanguage(row.brief),'));
    const yt = read('src/utils/youtube-video.ts');
    assert.ok(yt.includes("lang === 'en' ? 'en-GB' : lang") && yt.includes('if (code !== lang)'));
});

console.log(`\nvoice languages: ${passed} passed`);
})();
