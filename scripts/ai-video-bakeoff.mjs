#!/usr/bin/env node
// scripts/ai-video-bakeoff.mjs — the AI clip model bake-off (docs/video-producer-footage-and-ai-plan.md §5.3).
//
// One FLUX first frame per prompt, then the SAME frame and motion prompt through every candidate
// image-to-video model on fal, so the models are compared on motion and fidelity alone. Writes each
// clip and a results.json (timings, the price per second read off fal's model page on the day) to
// the output folder. Rerun quarterly with the candidates updated; the write-up goes in
// docs/ai-video-bakeoff-<date>.md.
//
// Spends real money on fal (round 1, 2026-11-01: 5 prompts × 7 models ≈ $35). The key is never
// printed — pass it from Netlify's environment:
//   FAL_KEY=$(netlify env:get FAL_KEY --context production) node scripts/ai-video-bakeoff.mjs <outDir> [promptId…]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.FAL_KEY;
if (!KEY) { console.error('FAL_KEY is not set'); process.exit(1); }
const [outDir, ...only] = process.argv.slice(2);
if (!outDir) { console.error('usage: ai-video-bakeoff.mjs <outDir> [promptId…]'); process.exit(1); }
mkdirSync(outDir, { recursive: true });

// Made-up people and businesses only — never a real person (plan §6).
export const PROMPTS = [
    { id: 'realistic', style: 'Realistic',
      frame: 'Photorealistic: a woman in her thirties with curly dark hair laughs while pouring coffee for a customer behind the counter of a small sunlit neighbourhood cafe, steam rising from the cup, natural window light, no text or signs',
      motion: 'She pours the coffee, looks up and smiles warmly at the customer. Gentle handheld camera, natural movement.' },
    { id: 'cinematic', style: 'Cinematic',
      frame: 'Cinematic photograph: early morning mist over a rugged coastline with a small white lighthouse on the cliff, waves breaking on dark rocks, golden sunrise light, no text',
      motion: 'Slow aerial drone push towards the lighthouse, waves rolling in and breaking, mist drifting.' },
    { id: '3d', style: '3D animated',
      frame: 'A cheerful 3D animated character, a small round orange robot with big friendly eyes, watering potted plants on a sunny windowsill, soft studio animation lighting, no text',
      motion: 'The robot tilts its watering can, water droplets fall onto the plants, then it bounces happily and blinks.' },
    { id: 'cartoon', style: '2D cartoon',
      frame: 'Flat 2D cartoon illustration: a smiling dog walker with three dogs on leads in a colourful park, bold clean outlines, bright pastel colours, no text',
      motion: 'They walk along the path, the dogs trot and wag their tails, autumn leaves drift down. Keep the flat 2D cartoon style.' },
    { id: 'product', style: 'Product and close-up',
      frame: 'Extreme close-up macro photograph of a handmade ceramic mug being glazed, a brush sweeping deep blue glaze across the clay, a potter\'s hands visible, studio light, shallow depth of field, no text',
      motion: 'The brush sweeps slowly across the mug, glaze spreading. Slow push-in, shallow depth of field.' },
];

// Prices are per second as listed on each fal model page on 2026-11-01, at the resolution used.
export const MODELS = [
    { id: 'kling/v4/image-to-video', label: 'Kling 4.0', usdPerS: 0.235, res: '1080p',
      input: (img, p) => ({ prompt: p, start_image_url: img, duration: 5, resolution: '1080p' }) },
    { id: 'fal-ai/kling-video/v3/pro/image-to-video', label: 'Kling 3.0 Pro', usdPerS: 0.112, res: '1080p',
      input: (img, p) => ({ prompt: p, start_image_url: img, duration: '5', generate_audio: false }) },
    { id: 'bytedance/seedance-2.5/us/image-to-video', label: 'Seedance 2.5', usdPerS: 0.473, res: '720p',
      input: (img, p) => ({ prompt: p, image_url: img, duration: '5', resolution: '720p', aspect_ratio: '9:16', generate_audio: false }) },
    { id: 'alibaba/wan-3.0/image-to-video', label: 'Wan 3.0', usdPerS: 0.20, res: '1080p',
      input: (img, p) => ({ prompt: p, start_image_url: img, duration: 5, resolution: '1080p', aspect_ratio: '9:16', audio: false }) },
    { id: 'google/gemini-omni-flash/v1.1/image-to-video', label: 'Gemini Omni Flash', usdPerS: 0.15, res: '1080p',
      input: (img, p) => ({ prompt: p, image_url: img, duration: 6, resolution: '1080p', aspect_ratio: '9:16' }) },
    { id: 'minimax/h3-max/image-to-video', label: 'MiniMax H3 Max', usdPerS: 0.112, res: '1080p',
      input: (img, p) => ({ prompt: p, image_url: img, duration: 6, resolution: '1080P', prompt_expansion_mode: 'balanced' }) },
    { id: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video', label: 'Kling 2.5 Turbo (today)', usdPerS: 0.07, res: '1080p',
      input: (img, p) => ({ prompt: p, image_url: img, duration: '5' }) },
];

const auth = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(modelId, input, timeoutMs = 15 * 60 * 1000) {
    const sub = await fetch(`https://queue.fal.run/${modelId}`, { method: 'POST', headers: auth, body: JSON.stringify(input) });
    const s = await sub.json();
    if (!sub.ok) throw new Error(`submit ${sub.status}: ${JSON.stringify(s).slice(0, 300)}`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        await sleep(5000);
        const st = await (await fetch(s.status_url, { headers: auth })).json();
        if (st.status === 'COMPLETED') break;
        if (st.status === 'FAILED' || st.error) throw new Error(`failed: ${JSON.stringify(st).slice(0, 300)}`);
        if (Date.now() > deadline) throw new Error('timed out');
    }
    const res = await fetch(s.response_url, { headers: auth });
    const body = await res.json();
    if (!res.ok) throw new Error(`result ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
}

async function download(url, file) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

const resultsFile = join(outDir, 'results.json');
const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : {};
const save = () => writeFileSync(resultsFile, JSON.stringify(results, null, 2));

for (const p of PROMPTS.filter((x) => !only.length || only.includes(x.id))) {
    results[p.id] ??= { style: p.style, frame: p.frame, motion: p.motion, clips: {} };
    if (!results[p.id].frameUrl) {
        const img = await run('fal-ai/flux-pro/v1.1', { prompt: p.frame, image_size: 'portrait_16_9', num_images: 1, safety_tolerance: '2' });
        results[p.id].frameUrl = img.images[0].url;
        await download(img.images[0].url, join(outDir, `${p.id}__frame.jpg`));
        save();
    }
    const frameUrl = results[p.id].frameUrl;
    console.log(`[${p.id}] frame ready; submitting ${MODELS.length} models`);
    await Promise.all(MODELS.map(async (m) => {
        const key = m.label;
        if (results[p.id].clips[key]?.file) return;
        const t0 = Date.now();
        try {
            const out = await run(m.id, m.input(frameUrl, p.motion));
            const url = out.video?.url ?? out.videos?.[0]?.url;
            if (!url) throw new Error(`no video in ${JSON.stringify(out).slice(0, 200)}`);
            const file = `${p.id}__${m.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.mp4`;
            await download(url, join(outDir, file));
            results[p.id].clips[key] = { model: m.id, file, seconds: Math.round((Date.now() - t0) / 1000), usdPerS: m.usdPerS, res: m.res };
            console.log(`[${p.id}] ${key} ✓ ${results[p.id].clips[key].seconds}s`);
        } catch (err) {
            results[p.id].clips[key] = { model: m.id, error: String(err.message || err).slice(0, 300) };
            console.log(`[${p.id}] ${key} ✗ ${results[p.id].clips[key].error}`);
        }
        save();
    }));
}
console.log('done');
