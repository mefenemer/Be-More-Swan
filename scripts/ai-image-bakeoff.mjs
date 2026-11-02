#!/usr/bin/env node
// scripts/ai-image-bakeoff.mjs — the AI image model bake-off.
//
// The SAME prompt through every candidate text-to-image model on fal, so the models are compared on
// the picture alone. Scene prompts are written the way visualisePrompt() writes them (a 50-90 word
// scene) with NO_TEXT_RULE appended, as fal-gateway does on every real call. The 'text' prompts are the
// exception: they ask for exact words, to test the "renders text precisely" claims — the product still
// puts words on as editable layers (bake-words.ts) whatever wins here.
//
// Writes each image, results.json (timings, failures, fal's listed price per image on the day) and
// index.html (side-by-side grid, blind mode) to the output folder. Rerunning skips images already on
// disk, so a failed model can be retried alone.
//
// Spends real money on fal (round 1, 2026-11-02: 16 prompts × 6 models ≈ $8). The key is never
// printed — pass it from Netlify's environment:
//   FAL_KEY=$(netlify env:get FAL_KEY --context production) node scripts/ai-image-bakeoff.mjs <outDir> [promptId…]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.FAL_KEY;
if (!KEY) { console.error('FAL_KEY is not set'); process.exit(1); }
const [outDir, ...only] = process.argv.slice(2);
if (!outDir) { console.error('usage: ai-image-bakeoff.mjs <outDir> [promptId…]'); process.exit(1); }
mkdirSync(outDir, { recursive: true });

// Kept in step with src/lib/image-prompt.ts.
const NO_TEXT_RULE = 'No text of any kind in the image: no words, letters, numbers, captions, headlines, signs, labels, logos or typography.';

// Made-up people and businesses only — never a real person.
export const PROMPTS = [
    { id: 'cafe', aspect: '4:5', use: 'Social post — people at work',
      scene: 'A barista in her twenties with a short auburn bob and a green apron slides a flat white across a worn oak counter to a smiling older customer in a small neighbourhood coffee shop. Morning sun streams through a steamy front window, catching the latte art. Eye-level shot, shallow depth of field, warm candid documentary photography, relaxed friendly mood.' },
    { id: 'yoga', aspect: '1:1', use: 'Social post — class / group',
      scene: 'A small mixed-age yoga class of six people holding warrior two pose in a bright wooden studio with tall windows overlooking a harbour at dawn. The instructor, a man in his fifties with a grey beard, adjusts a student\'s arm. Wide shot from the back corner, soft pastel morning light, calm and welcoming, natural photographic style.' },
    { id: 'plumber', aspect: '4:5', use: 'Social post — trades',
      scene: 'A tradeswoman plumber in navy overalls kneels under a modern kitchen sink, tightening a chrome pipe fitting with a wrench, a neat open toolbox beside her on the tiled floor. Low angle from the side, bright natural daylight from a nearby window, crisp realistic photography that feels trustworthy and professional.' },
    { id: 'groomer', aspect: '1:1', use: 'Social post — pets',
      scene: 'A fluffy apricot cockapoo sits proudly on a grooming table just after a trim, ears freshly fluffed, a small blue bow on its collar, while the groomer\'s hands hold a slicker brush at the edge of frame. Clean pastel grooming salon background, soft even studio light, playful cheerful mood, close-up photograph.' },
    { id: 'bakery-product', aspect: '1:1', use: 'Product close-up',
      scene: 'Overhead flat-lay of a rustic sourdough loaf scored in a wheat pattern, cut open to show an airy crumb, on a floured linen cloth beside a small dish of salted butter and a vintage bread knife. Soft directional window light from the left, rich texture, muted earthy tones, artisan food photography.' },
    { id: 'pottery-macro', aspect: '4:5', use: 'Product close-up — hands',
      scene: 'Extreme close-up of a potter\'s clay-covered hands shaping a tall vase on a spinning wheel, water glistening on the wet clay, fine spirals forming in the surface. Studio lighting with a dark background, shallow depth of field, tactile and calm, macro photography.' },
    { id: 'florist', aspect: '9:16', use: 'Story / reel cover',
      scene: 'A florist in a linen apron arranges a large loose bouquet of peonies, garden roses and eucalyptus in a ceramic jug on a workbench inside a small plant-filled shop, buckets of fresh flowers around her. Vertical composition, soft afternoon light, romantic and abundant, natural photography.' },
    { id: 'accountant-metaphor', aspect: '16:9', use: 'Blog header — abstract idea',
      scene: 'A visual metaphor for calm financial planning: a small paper boat sailing steadily across a still lake at sunrise while distant storm clouds clear behind it. Wide cinematic composition, gentle golden light reflecting on the water, reassuring and hopeful mood, photographic style.' },
    { id: 'therapy-room', aspect: '16:9', use: 'Website hero — interior',
      scene: 'A welcoming counselling room with two comfortable armchairs facing each other at a slight angle, a low table with a box of tissues and a glass of water, a large leafy plant and a soft woollen throw. Late afternoon light through sheer curtains, warm neutral palette, quiet and safe atmosphere, interior photography.' },
    { id: 'garden-wide', aspect: '16:9', use: 'Blog header — landscape',
      scene: 'A landscaper in work gloves lays the final stone of a curved sandstone path through a newly planted cottage garden of lavender, foxgloves and ornamental grasses, a wheelbarrow nearby. Wide shot, golden hour backlight, lush and satisfying, natural photography.' },
    { id: 'cartoon', aspect: '1:1', use: 'Illustration — flat 2D',
      scene: 'Flat 2D vector-style illustration of a cheerful bicycle repair shop: a mechanic with round glasses fixing a red bike on a stand, tools on a pegboard wall, a cat asleep on a stack of tyres. Bold clean outlines, limited bright pastel palette, friendly modern editorial illustration.' },
    { id: '3d-mascot', aspect: '1:1', use: 'Illustration — 3D',
      scene: 'A cute 3D animated character, a small round teal robot with big friendly eyes, carrying a stack of parcels across a tidy office desk with a laptop and a potted succulent. Soft studio animation lighting, glossy materials, playful and upbeat, Pixar-like render.' },
    { id: 'hands-diverse', aspect: '4:5', use: 'Hard case — hands and faces',
      scene: 'Four colleagues of different ages and ethnicities stand around a café table piling their hands together in a team huddle, laughing, coffee cups and a notebook on the table. Close-to-medium shot, natural window light, genuine candid joy, realistic photography with natural skin texture.' },
    { id: 'text-sign', aspect: '4:5', use: 'Text test — sign', allowText: true, words: 'Open Saturday 9am',
      scene: 'A hand-painted chalkboard A-frame sign standing outside a bakery door on a cobbled street. The sign reads exactly "Open Saturday 9am" in neat white chalk lettering. Morning light, realistic photography. Spell the words exactly as given.' },
    { id: 'text-flyer', aspect: '4:5', use: 'Text test — flyer layout', allowText: true, words: 'Summer Yoga Retreat / 14–16 June / Book now',
      scene: 'A clean modern event flyer design for a yoga retreat, a calm illustration of a woman meditating on a hill at sunset in the top half, and below it the headline "Summer Yoga Retreat", the date line "14–16 June" and a button reading "Book now". Balanced layout, soft coral and sage palette. Spell every word exactly as given.' },
    { id: 'text-long', aspect: '1:1', use: 'Text test — longer phrase', allowText: true, words: 'Willowbrook Coffee Roasters — freshly roasted every Thursday',
      scene: 'A kraft paper coffee bag standing on a wooden shelf with a printed label that reads exactly "Willowbrook Coffee Roasters — freshly roasted every Thursday". Soft shop lighting, product photography. Spell the words exactly as given.' },
];

// The size each model is asked for, per aspect. FLUX + Recraft use fal's named presets (matching
// imageSizeForAspect in fal-gateway.ts), Gemini takes an aspect ratio, GPT Image only has 3 sizes.
const PRESET = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:5': { width: 1024, height: 1280 } };
const GPT_SIZE = { '1:1': '1024x1024', '16:9': '1536x1024', '9:16': '1024x1536', '4:5': '1024x1536' };

export const MODELS = [
    { id: 'fal-ai/flux-pro/v1.1', label: 'FLUX 1.1 Pro (today)',
      input: (prompt, aspect) => ({ prompt, image_size: PRESET[aspect], safety_tolerance: '2', output_format: 'jpeg' }) },
    { id: 'fal-ai/flux-2-pro', label: 'FLUX.2 Pro',
      input: (prompt, aspect) => ({ prompt, image_size: PRESET[aspect], safety_tolerance: '2', output_format: 'jpeg' }) },
    { id: 'fal-ai/flux-2-max', label: 'FLUX.2 Max',
      input: (prompt, aspect) => ({ prompt, image_size: PRESET[aspect], safety_tolerance: '2', output_format: 'jpeg' }) },
    { id: 'fal-ai/nano-banana-pro', label: 'Gemini 3 Pro Image (Nano Banana Pro)',
      input: (prompt, aspect) => ({ prompt, aspect_ratio: aspect, resolution: '1K', output_format: 'jpeg', num_images: 1 }) },
    { id: 'fal-ai/gpt-image-1.5', label: 'GPT Image 1.5 (medium)',
      input: (prompt, aspect) => ({ prompt, image_size: GPT_SIZE[aspect], quality: 'medium', output_format: 'jpeg', num_images: 1 }) },
    { id: 'fal-ai/recraft/v4/text-to-image', label: 'Recraft V4',
      input: (prompt, aspect) => ({ prompt, image_size: aspect === '4:5' ? 'portrait_4_3' : PRESET[aspect] }) },
];

const auth = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileFor = (p, m) => `${p.id}__${m.id.replace(/[^a-z0-9.]+/gi, '_')}.jpg`;

async function run(modelId, input, timeoutMs = 5 * 60 * 1000) {
    const sub = await fetch(`https://queue.fal.run/${modelId}`, { method: 'POST', headers: auth, body: JSON.stringify(input) });
    const s = await sub.json();
    if (!sub.ok) throw new Error(`submit ${sub.status}: ${JSON.stringify(s).slice(0, 300)}`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        await sleep(2000);
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// fal's listed price per unit, read on the day. Best effort — a failure leaves the price blank.
async function prices() {
    const qs = MODELS.map((m) => `endpoint_id=${encodeURIComponent(m.id)}`).join('&');
    try {
        const res = await fetch(`https://api.fal.ai/v1/models/pricing?${qs}`, { headers: auth });
        const body = await res.json();
        return Object.fromEntries((body.prices ?? []).map((p) => [p.endpoint_id, { usd: p.unit_price, unit: p.unit }]));
    } catch { return {}; }
}

const resultsFile = join(outDir, 'results.json');
const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : { runs: {} };
results.date = new Date().toISOString().slice(0, 10);
results.prices = await prices();
results.prompts = PROMPTS;
results.models = MODELS.map(({ id, label }) => ({ id, label }));
const save = () => writeFileSync(resultsFile, JSON.stringify(results, null, 2));

const todo = PROMPTS.filter((p) => !only.length || only.includes(p.id));
// One prompt at a time, every model in parallel — fal's per-key concurrency is fine with 6.
for (const p of todo) {
    const prompt = p.allowText ? p.scene : `${p.scene} ${NO_TEXT_RULE}`;
    await Promise.all(MODELS.map(async (m) => {
        const file = fileFor(p, m);
        const key = `${p.id}|${m.id}`;
        if (existsSync(join(outDir, file)) && results.runs[key]?.ok) return;
        const t0 = Date.now();
        try {
            const out = await run(m.id, m.input(prompt, p.aspect));
            const url = out.images?.[0]?.url ?? out.image?.url;
            if (!url) throw new Error(`no image in response: ${JSON.stringify(out).slice(0, 200)}`);
            await download(url, join(outDir, file));
            results.runs[key] = { ok: true, file, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
            console.log(`✓ ${p.id} · ${m.label} · ${results.runs[key].seconds}s`);
        } catch (e) {
            results.runs[key] = { ok: false, error: String(e.message ?? e).slice(0, 300) };
            console.log(`✗ ${p.id} · ${m.label} · ${results.runs[key].error}`);
        }
        save();
    }));
}
save();

// ── Side-by-side page ──────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rows = PROMPTS.map((p) => {
    const cells = MODELS.map((m, i) => {
        const r = results.runs[`${p.id}|${m.id}`];
        const body = r?.ok
            ? `<a href="${esc(r.file)}" target="_blank"><img loading="lazy" src="${esc(r.file)}" alt="${esc(m.label)} — ${esc(p.id)}"></a>`
            : `<div class="fail">${esc(r?.error ?? 'not run')}</div>`;
        return `<figure><figcaption><span class="real">${esc(m.label)}</span><span class="blind">Model ${'ABCDEF'[i]}</span>${r?.ok ? ` · ${r.seconds}s` : ''}</figcaption>${body}</figure>`;
    }).join('');
    return `<section><h2>${esc(p.use)} <small>${esc(p.aspect)}${p.words ? ` · must read “${esc(p.words)}”` : ''}</small></h2><p class="prompt">${esc(p.scene)}</p><div class="grid">${cells}</div></section>`;
}).join('\n');
const priceRows = MODELS.map((m) => {
    const pr = results.prices[m.id];
    const ok = PROMPTS.filter((p) => results.runs[`${p.id}|${m.id}`]?.ok);
    const secs = ok.map((p) => results.runs[`${p.id}|${m.id}`].seconds).sort((a, b) => a - b);
    const median = secs.length ? secs[Math.floor(secs.length / 2)] : '–';
    return `<tr><td>${esc(m.label)}</td><td>${pr ? `$${pr.usd} / ${esc(pr.unit)}` : '–'}</td><td>${median}s</td><td>${ok.length}/${PROMPTS.length}</td></tr>`;
}).join('');
writeFileSync(join(outDir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Image Model Bake-off</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--bad:#f87171}}
:root[data-theme="dark"]{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--bad:#f87171}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1600px;margin:0 auto;padding:24px 16px 64px}
h1{margin:0 0 4px}h2{font-size:17px;margin:40px 0 4px}h2 small{color:var(--muted);font-weight:400}
.prompt{color:var(--muted);font-size:13px;margin:0 0 12px;max-width:900px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
figcaption{font-size:12px;padding:6px 8px;color:var(--muted)}img{display:block;width:100%;height:auto}
.fail{padding:12px;color:var(--bad);font-size:12px;word-break:break-word}
table{border-collapse:collapse;margin:12px 0;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 12px;text-align:left}
label{display:inline-flex;gap:6px;align-items:center;margin:8px 0;cursor:pointer}
body.blind .real,body:not(.blind) .blind{display:none}
</style></head><body><main>
<h1>Image model bake-off</h1><p class="prompt">Run ${esc(results.date)}. The same prompt through every model; scene prompts carry the no-text rule exactly as production does. Click any image for full size.</p>
<table><tr><th>Model</th><th>fal list price</th><th>Median time</th><th>Succeeded</th></tr>${priceRows}</table>
<label><input type="checkbox" id="blind"> Blind mode (hide model names, A–F in the same order every row)</label>
${rows}
</main><script>document.getElementById('blind').addEventListener('change',e=>document.body.classList.toggle('blind',e.target.checked))</script></body></html>`);
console.log(`\nWrote ${join(outDir, 'index.html')}`);
