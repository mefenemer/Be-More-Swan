#!/usr/bin/env node
// scripts/ai-avatar-bakeoff.mjs — the AI presenter model bake-off (docs/video-producer-screen-walkthrough-plan.md §11.2, Phase A0).
//
// Two made-up presenters (one female, one male) are drawn once with FLUX.2 Pro; three short lines are spoken
// by voices from src/public/voice-catalogue.json (ElevenLabs). Then the SAME face + SAME audio go through
// every candidate audio-driven avatar model on fal, so the models are compared on lip-sync and movement
// alone. A longer English line goes through the expected default only, to look for drift. Writes every
// file plus results.json (timings, cost at the price on each model's fal page on the day) to <outDir>.
//
// Spends real money on the LIVE fal and ElevenLabs balances (round 1, 2026-11-15: $21.43 on fal, a few cents of
// ElevenLabs) — check the fal balance first, and update MODELS' prices from each fal page. Keys are never printed:
//   FAL_KEY=$(netlify env:get FAL_KEY --context production) \
//   ELEVENLABS_API_KEY=$(netlify env:get ELEVENLABS_API_KEY --context production) \
//   BAKEOFF_DATE=2026-11-15 node scripts/ai-avatar-bakeoff.mjs <outDir> [step]
//     step = faces | voices | clips | drift | welsh | all (default: every step above, in order)
//            | welshclip (on its own, after welsh: the eleven_v3 Welsh line through MODELS[0])
// Each step skips files that already exist, so a rerun only redoes what failed.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const FAL = process.env.FAL_KEY;
const EL = process.env.ELEVENLABS_API_KEY;
const [outDir, step = 'all'] = process.argv.slice(2);
if (!outDir) { console.error('usage: ai-avatar-bakeoff.mjs <outDir> [faces|voices|clips|drift|welsh|all|welshclip]'); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const want = (s) => step === 'all' || step === s;

// Made-up people only — never a real person, never named after one (plan §11.3, §11.6).
const FACES = [
    { id: 'female', prompt: 'Photorealistic portrait photograph of a friendly woman in her late thirties with shoulder-length brown hair, wearing a navy blazer over a plain white top, waist up, centred, looking straight into the camera with a gentle closed-mouth smile, hands relaxed out of frame, plain soft light-grey studio background, soft even studio lighting, sharp focus, 16:9, no text, no logo' },
    { id: 'male', prompt: 'Photorealistic portrait photograph of a friendly man in his mid forties with short dark hair and a neat short beard, wearing a plain charcoal crew-neck jumper, waist up, centred, looking straight into the camera with a relaxed closed-mouth smile, hands relaxed out of frame, plain soft light-grey studio background, soft even studio lighting, sharp focus, 16:9, no text, no logo' },
];

// ~12 s each at a natural pace. Voices are catalogue ids (src/public/voice-catalogue.json).
const LINES = [
    { id: 'en_female', face: 'female', voice: '6vIP9mPY4dr6w8krUg01', voiceName: 'Pepper (en)', lang: 'en',
      text: "Hi, I'm going to show you around. In the next few minutes you'll see how to book a client, send a reminder and get paid, all from one simple dashboard. Let's start." },
    { id: 'fr_male', face: 'male', voice: 'aQROLel5sQbj1vuIVi6B', voiceName: 'Nicolas (fr)', lang: 'fr',
      text: "Bonjour, je vais vous faire visiter. Dans quelques minutes, vous verrez comment réserver un client, envoyer un rappel et être payé, le tout depuis un seul tableau de bord. On commence." },
    { id: 'pl_female', face: 'female', voice: 'NacdHGUYR1k3M0FAbAia', voiceName: 'Hanna (pl)', lang: 'pl',
      text: "Cześć, pokażę Ci, jak to działa. W ciągu kilku minut zobaczysz, jak zarezerwować klienta, wysłać przypomnienie i otrzymać płatność, wszystko z jednego prostego panelu. Zaczynajmy." },
];
const DRIFT = { id: 'en_male_long', face: 'male', voice: 'Fahco4VZzobUeiPqni1S', voiceName: 'Archer (en)', lang: 'en',
    text: "Welcome. I'm going to walk you through the whole thing, start to finish. First, the dashboard. Everything you need today is right here: your bookings, the messages waiting for a reply, and the money coming in this week. Next, let's add a new client. Type their name, their email and their phone number, then choose the service they want. It takes about ten seconds. Now, reminders. Every client gets a text the day before, so fewer people forget. And when the job's done, you send the invoice from the same screen, and they can pay by card straight away. That's it. Simple, and all in one place." };

// Prices per output second from each model's fal page on 2026-11-15, at the resolution used. Re-read them on every rerun.
const MODELS = [
    { id: 'fal-ai/kling-video/ai-avatar/v2/standard', label: 'Kling AI Avatar v2 Standard', usdPerS: 0.0562, input: (img, aud) => ({ image_url: img, audio_url: aud }) },
    { id: 'fal-ai/kling-video/ai-avatar/v2/pro', label: 'Kling AI Avatar v2 Pro', usdPerS: 0.115, input: (img, aud) => ({ image_url: img, audio_url: aud }) },
    { id: 'fal-ai/bytedance/omnihuman/v1.5', label: 'OmniHuman 1.5 (720p)', usdPerS: 0.16, input: (img, aud) => ({ image_url: img, audio_url: aud, resolution: '720p' }) },
    { id: 'veed/fabric-1.0', label: 'VEED Fabric 1.0 (720p)', usdPerS: 0.15, input: (img, aud) => ({ image_url: img, audio_url: aud, resolution: '720p' }) },
    { id: 'fal-ai/heygen/avatar4/image-to-video', label: 'HeyGen Avatar IV (720p)', usdPerS: 0.10, input: (img, aud) => ({ image_url: img, audio_url: aud, resolution: '720p' }) },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const falAuth = () => { if (!FAL) throw new Error('FAL_KEY is not set'); return { Authorization: `Key ${FAL}`, 'Content-Type': 'application/json' }; };
const resultsFile = join(outDir, 'results.json');
const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : { date: process.env.BAKEOFF_DATE || new Date().toISOString().slice(0, 10), faces: {}, voices: {}, clips: [], welsh: {} };
const save = () => writeFileSync(resultsFile, JSON.stringify(results, null, 2));

async function falRun(modelId, input, timeoutMs = 20 * 60 * 1000) {
    const sub = await fetch(`https://queue.fal.run/${modelId}`, { method: 'POST', headers: falAuth(), body: JSON.stringify(input) });
    const s = await sub.json();
    if (!sub.ok) throw new Error(`submit ${sub.status}: ${JSON.stringify(s).slice(0, 400)}`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        await sleep(5000);
        const st = await (await fetch(s.status_url, { headers: falAuth() })).json();
        if (st.status === 'COMPLETED') break;
        if (st.status === 'FAILED' || st.error) throw new Error(`failed: ${JSON.stringify(st).slice(0, 400)}`);
        if (Date.now() > deadline) throw new Error('timed out');
    }
    const res = await fetch(s.response_url, { headers: falAuth() });
    const body = await res.json();
    if (!res.ok) throw new Error(`result ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    return body;
}

// fal takes file inputs as URLs; upload local bytes to fal's CDN once and reuse the URL.
async function falUpload(file, contentType) {
    const init = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
        method: 'POST', headers: falAuth(), body: JSON.stringify({ content_type: contentType, file_name: file.split('/').pop() }),
    });
    const j = await init.json();
    if (!init.ok) throw new Error(`upload initiate ${init.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const put = await fetch(j.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: readFileSync(file) });
    if (!put.ok) throw new Error(`upload put ${put.status}`);
    return j.file_url;
}

async function download(url, file) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

const durationOf = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

async function faces() {
    for (const f of FACES) {
        const file = join(outDir, `face-${f.id}.png`);
        if (existsSync(file) && results.faces[f.id]?.url) continue;
        const out = await falRun('fal-ai/flux-2-pro', { prompt: f.prompt, image_size: 'landscape_16_9', output_format: 'png', safety_tolerance: '2' });
        const url = out.images?.[0]?.url;
        if (!url) throw new Error(`no image for ${f.id}`);
        await download(url, file);
        results.faces[f.id] = { url, prompt: f.prompt };
        save();
        console.log(`face ${f.id} done`);
    }
}

async function speak(line) {
    const file = join(outDir, `voice-${line.id}.mp3`);
    if (!existsSync(file)) {
        if (!EL) throw new Error('ELEVENLABS_API_KEY is not set');
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${line.voice}?output_format=mp3_44100_128`, {
            method: 'POST', headers: { 'xi-api-key': EL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: line.text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 } }),
        });
        if (!r.ok) throw new Error(`tts ${line.id} ${r.status}: ${(await r.text()).slice(0, 200)}`);
        writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    if (!results.voices[line.id]?.url) {
        results.voices[line.id] = { url: await falUpload(file, 'audio/mpeg'), seconds: durationOf(file), voice: line.voiceName, lang: line.lang, text: line.text };
        save();
    }
    console.log(`voice ${line.id}: ${results.voices[line.id].seconds.toFixed(1)} s`);
}

async function clip(model, line) {
    const key = `${model.id}|${line.id}`;
    const file = join(outDir, `clip-${model.id.replace(/[^a-z0-9]+/gi, '_')}-${line.id}.mp4`);
    const prev = results.clips.find((c) => c.key === key);
    if (prev && prev.ok && existsSync(file)) return;
    const t0 = Date.now();
    const row = { key, model: model.label, modelId: model.id, line: line.id, file: file.split('/').pop() };
    try {
        const out = await falRun(model.id, model.input(results.faces[line.face].url, results.voices[line.id].url));
        const url = out.video?.url;
        if (!url) throw new Error(`no video: ${JSON.stringify(out).slice(0, 300)}`);
        await download(url, file);
        const seconds = durationOf(file);
        Object.assign(row, { ok: true, seconds, waitS: Math.round((Date.now() - t0) / 1000), usd: Math.round(seconds * model.usdPerS * 100) / 100 });
    } catch (e) {
        Object.assign(row, { ok: false, error: String(e.message || e).slice(0, 400), waitS: Math.round((Date.now() - t0) / 1000) });
    }
    results.clips = results.clips.filter((c) => c.key !== key).concat(row);
    save();
    console.log(`${row.ok ? 'ok ' : 'ERR'} ${model.label} / ${line.id}${row.ok ? ` ${row.seconds.toFixed(1)} s, ${row.waitS} s wait, $${row.usd}` : ` ${row.error}`}`);
}

// Welsh: does ElevenLabs speak it? Speak one line, then have Scribe write down what it heard in Welsh.
async function welsh() {
    if (!EL) throw new Error('ELEVENLABS_API_KEY is not set');
    const text = 'Croeso! Heddiw, rydw i am ddangos i chi sut i archebu apwyntiad a chael eich talu, i gyd o un lle syml.';
    for (const [model, voice] of [['eleven_multilingual_v2', '6vIP9mPY4dr6w8krUg01'], ['eleven_v3', '6vIP9mPY4dr6w8krUg01']]) {
        const file = join(outDir, `welsh-${model}.mp3`);
        const row = { model, text };
        try {
            if (!existsSync(file)) {
                const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
                    method: 'POST', headers: { 'xi-api-key': EL, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, model_id: model, language_code: 'cy' }),
                });
                if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 300)}`);
                writeFileSync(file, Buffer.from(await r.arrayBuffer()));
            }
            const form = new FormData();
            form.append('model_id', 'scribe_v1');
            form.append('language_code', 'cy');
            form.append('file', new Blob([readFileSync(file)], { type: 'audio/mpeg' }), 'welsh.mp3');
            const s = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': EL }, body: form });
            const j = await s.json();
            if (!s.ok) throw new Error(`scribe ${s.status}: ${JSON.stringify(j).slice(0, 300)}`);
            Object.assign(row, { ok: true, file: file.split('/').pop(), heard: j.text ?? JSON.stringify(j).slice(0, 300) });
        } catch (e) {
            Object.assign(row, { ok: false, error: String(e.message || e).slice(0, 400) });
        }
        results.welsh[model] = row;
        save();
        console.log(`welsh ${model}: ${row.ok ? row.heard : row.error}`);
    }
}

if (want('faces')) await faces();
if (want('voices')) { for (const l of LINES) await speak(l); }
if (want('clips')) await Promise.all(MODELS.flatMap((m) => LINES.map((l) => clip(m, l))));
if (want('drift')) { await speak(DRIFT); await clip(MODELS[0], DRIFT); }
if (want('welsh')) await welsh();
// Welsh through the expected default: eleven_v3 audio (multilingual_v2 refuses 'cy') on the female face.
if (step === 'welshclip') {
    const line = { id: 'cy_female', face: 'female', lang: 'cy' };
    const file = join(outDir, 'welsh-eleven_v3.mp3');
    if (!existsSync(file) || !results.welsh.eleven_v3?.ok) { console.error('Run the welsh step first: no working eleven_v3 Welsh line yet.'); process.exit(1); }
    if (!results.voices[line.id]?.url) {
        results.voices[line.id] = { url: await falUpload(file, 'audio/mpeg'), seconds: durationOf(file), voice: 'Pepper (eleven_v3, cy)', lang: 'cy', text: results.welsh.eleven_v3?.text };
        save();
    }
    await clip(MODELS[0], line);
}
const spent = results.clips.filter((c) => c.ok).reduce((a, c) => a + c.usd, 0);
console.log(`fal clips so far: $${spent.toFixed(2)} (plus 2 FLUX images)`);
