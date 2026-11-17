#!/usr/bin/env node
// scripts/make-presenters.mjs — the AI presenter roster's files (docs/video-producer-screen-walkthrough-plan.md
// §11.3, Phase A1). For every presenter in src/public/presenter-catalogue.json:
//
//   presenters/<id>.jpg        the face: FLUX.2 Pro from the written description below, 1920×1080, plain grey studio
//   presenters/<id>-thumb.jpg  480×270, for the picker
//   presenters/<id>.mp4        a 5-second hello in their own English voice (ElevenLabs), lip-synced by the catalogue's
//                              avatar model (Kling AI Avatar v2 Standard), 640×360 — what the picker plays
//
// Made once and committed (served as static files, like audio/voices/): a presenter whose file exists is skipped,
// so adding one to the catalogue and re-running costs only that one. `--redo id,id` makes those again (a face that
// didn't pass the eye check). Every face is made up: never describe, name or reference a real person.
//
// Spends real money on the LIVE fal and ElevenLabs balances (12 presenters ≈ $0.40 of faces + ≈ $3.50 of clips).
// Keys come from Netlify and are never printed:
//   FAL_KEY=$(netlify env:get FAL_KEY --context production) \
//   ELEVENLABS_API_KEY=$(netlify env:get ELEVENLABS_API_KEY --context production) \
//   node scripts/make-presenters.mjs [faces|samples|all] [--redo id,id]
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = JSON.parse(readFileSync(join(root, 'src/public/presenter-catalogue.json'), 'utf8'));
const out = join(root, 'presenters');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const ri = args.indexOf('--redo');
const redo = new Set(ri >= 0 ? (args[ri + 1] || '').split(',').filter(Boolean) : []);
const step = args.find((a, i) => !a.startsWith('--') && (ri < 0 || i !== ri + 1)) || 'all';

// Who each presenter looks like — written for this roster, about no one real.
const LOOKS = {
    amara: 'a friendly Black British woman in her early thirties with shoulder-length box braids, wearing a mustard-yellow knit jumper',
    priya: 'a cheerful South Asian woman in her late twenties with long dark hair, wearing a teal blouse',
    grace: 'a warm white woman in her mid fifties with a short silver bob, wearing a navy blazer over a white top',
    mei: 'a confident East Asian woman in her mid forties with shoulder-length straight black hair, wearing a cream shirt',
    sofia: 'a relaxed Mediterranean woman in her mid thirties with wavy brown hair, wearing a rust-coloured cardigan over a white tee',
    eileen: 'a kind white woman in her mid sixties with short curly grey hair and round glasses, wearing a bottle-green jumper',
    daniel: 'an approachable white man in his early thirties with short brown hair and light stubble, wearing a light-blue oxford shirt',
    kwame: 'a calm Black man of West African heritage in his mid forties with a short neat beard, wearing a charcoal blazer over a grey tee',
    arjun: 'an upbeat South Asian man in his mid twenties with neat black hair, wearing a white polo shirt',
    luis: 'a friendly Latino man in his late thirties with dark curly hair, wearing an olive-green overshirt',
    callum: 'a good-humoured white man in his mid fifties with a ginger-grey beard, wearing a navy crew-neck jumper',
    kenji: 'a thoughtful Japanese man in his early sixties with short grey hair and thin-framed glasses, wearing a brown tweed jacket over a shirt',
};
const facePrompt = (look) => `Photorealistic portrait photograph of ${look}, a made-up person, waist up, centred in the middle third of the frame with plenty of space on both sides, looking straight into the camera with a relaxed, natural closed-mouth smile, shoulders relaxed, hands out of frame, plain soft light-grey studio background, soft even studio lighting, natural skin texture, sharp focus, 16:9, no text, no logo, no jewellery logos`;
const hello = (name) => `Hi, I'm ${name}. I'll walk you through it, step by step.`;

const FAL = process.env.FAL_KEY;
const EL = process.env.ELEVENLABS_API_KEY;
const falAuth = () => { if (!FAL) throw new Error('FAL_KEY is not set'); return { Authorization: `Key ${FAL}`, 'Content-Type': 'application/json' }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function falRun(modelId, input, timeoutMs = 20 * 60 * 1000) {
    const sub = await fetch(`https://queue.fal.run/${modelId}`, { method: 'POST', headers: falAuth(), body: JSON.stringify(input) });
    const s = await sub.json();
    if (!sub.ok) throw new Error(`submit ${sub.status}: ${JSON.stringify(s).slice(0, 300)}`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        await sleep(5000);
        const res = await fetch(s.status_url, { headers: falAuth() });
        const st = await res.json().catch(() => ({}));
        if (!res.ok && res.status >= 400 && res.status < 500) throw new Error(`status ${res.status}: ${JSON.stringify(st).slice(0, 300)}`);
        if (st.status === 'COMPLETED') break;
        if (st.status === 'FAILED' || st.error) throw new Error(`failed: ${JSON.stringify(st).slice(0, 300)}`);
        if (Date.now() > deadline) throw new Error('timed out');
    }
    const res = await fetch(s.response_url, { headers: falAuth() });
    const body = await res.json();
    if (!res.ok) throw new Error(`result ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
}
async function falUpload(file, contentType) {
    const init = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', { method: 'POST', headers: falAuth(), body: JSON.stringify({ content_type: contentType, file_name: file.split('/').pop() }) });
    const j = await init.json();
    if (!init.ok) throw new Error(`upload initiate ${init.status}`);
    const put = await fetch(j.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: readFileSync(file) });
    if (!put.ok) throw new Error(`upload put ${put.status}`);
    return j.file_url;
}
async function download(url, file) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
const ffmpeg = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);

async function face(p) {
    const file = join(out, `${p.id}.jpg`);
    if (existsSync(file) && !redo.has(p.id)) return;
    const look = LOOKS[p.id];
    if (!look) throw new Error(`no description for ${p.id} in LOOKS`);
    const res = await falRun('fal-ai/flux-2-pro', { prompt: facePrompt(look), image_size: { width: 1920, height: 1080 }, output_format: 'png', safety_tolerance: '2' });
    const url = res.images?.[0]?.url;
    if (!url) throw new Error(`no image for ${p.id}`);
    const png = join(out, `${p.id}.tmp.png`);
    await download(url, png);
    ffmpeg('-i', png, '-vf', 'scale=1920:1080', '-q:v', '3', file);
    ffmpeg('-i', png, '-vf', 'scale=480:270', '-q:v', '4', join(out, `${p.id}-thumb.jpg`));
    rmSync(png);
    rmSync(join(out, `${p.id}.mp4`), { force: true });   // a new face needs a new sample
    console.log(`face ${p.id} done`);
}

async function sample(p) {
    const file = join(out, `${p.id}.mp4`);
    if (existsSync(file) && !redo.has(p.id)) return;
    if (!EL) throw new Error('ELEVENLABS_API_KEY is not set');
    const voices = JSON.parse(readFileSync(join(root, 'src/public/voice-catalogue.json'), 'utf8')).voices;
    const v = voices.find((x) => x.id === p.voices.en);
    if (!v?.elevenlabs) throw new Error(`${p.id}: English voice ${p.voices.en} has no ElevenLabs id`);
    // ElevenLabs answers 429 when too many requests run at once: wait and try again (at most 4 times).
    let r;
    for (let attempt = 0; ; attempt++) {
        r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.elevenlabs}?output_format=mp3_44100_128`, {
            method: 'POST', headers: { 'xi-api-key': EL, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: hello(p.name), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 } }),
        });
        if (r.status !== 429 || attempt >= 3) break;
        await sleep(5000 * (attempt + 1));
    }
    if (!r.ok) throw new Error(`tts ${p.id} ${r.status}`);
    const mp3 = join(out, `${p.id}.tmp.mp3`);
    writeFileSync(mp3, Buffer.from(await r.arrayBuffer()));
    const [imageUrl, audioUrl] = await Promise.all([falUpload(join(out, `${p.id}.jpg`), 'image/jpeg'), falUpload(mp3, 'audio/mpeg')]);
    const res = await falRun(catalogue.model, { image_url: imageUrl, audio_url: audioUrl });
    if (!res.video?.url) throw new Error(`no video for ${p.id}`);
    const raw = join(out, `${p.id}.tmp.mp4`);
    await download(res.video.url, raw);
    ffmpeg('-i', raw, '-vf', 'scale=640:360', '-c:v', 'libx264', '-crf', '27', '-preset', 'slow', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', file);
    rmSync(raw); rmSync(mp3);
    console.log(`sample ${p.id} done`);
}

const list = catalogue.presenters;
if (step === 'faces' || step === 'all') await Promise.all(list.map((p) => face(p).catch((e) => console.error(`face ${p.id}: ${e.message}`))));
// Three at a time: ElevenLabs limits how many voices are made at once.
async function inBatches(items, n, fn) { for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn)); }
if (step === 'samples' || step === 'all') await inBatches(list, 3, (p) => sample(p).catch((e) => console.error(`sample ${p.id}: ${e.message}`)));
