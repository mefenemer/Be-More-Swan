// scripts/make-voice-samples.mjs
// The "listen" samples in the voice picker: one short line per voice, in its own language, saved to
// audio/voices/<id>.mp3 (committed, served as static files). The same sentence for every voice of a
// language, so they can be compared like for like. Made once — a voice that already has a file is
// skipped, so adding a voice to src/public/voice-catalogue.json and re-running costs only that voice.
//
//   ELEVENLABS_API_KEY=… OPENAI_API_KEY=… node scripts/make-voice-samples.mjs [--force id,id]
//
// ~40 voices × ~90 characters ≈ 3,600 ElevenLabs characters. Legacy voices get no sample (not offered).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { voices } = JSON.parse(readFileSync(join(root, 'src/public/voice-catalogue.json'), 'utf8'));
const out = join(root, 'audio/voices');
mkdirSync(out, { recursive: true });

const LINE = {
    en: (n) => `Hi, I'm ${n}. This is how your videos could sound: clear, natural, and ready to share.`,
    fr: (n) => `Bonjour, je suis ${n}. Voici comment vos vidéos pourraient sonner : claires, naturelles et prêtes à partager.`,
    de: (n) => `Hallo, ich bin ${n}. So könnten Ihre Videos klingen: klar, natürlich und bereit zum Teilen.`,
    es: (n) => `Hola, soy ${n}. Así podrían sonar tus vídeos: claros, naturales y listos para compartir.`,
    it: (n) => `Ciao, sono ${n}. Ecco come potrebbero suonare i tuoi video: chiari, naturali e pronti da condividere.`,
    pt: (n) => `Olá, eu sou ${n}. É assim que os seus vídeos podem soar: claros, naturais e prontos para compartilhar.`,
    nl: (n) => `Hallo, ik ben ${n}. Zo kunnen je video's klinken: helder, natuurlijk en klaar om te delen.`,
    pl: (n) => `Cześć, jestem ${n}. Tak mogą brzmieć twoje filmy: wyraźnie, naturalnie i gotowe do udostępnienia.`,
    ar: (n) => `مرحبًا، أنا ${n}. هكذا يمكن أن تبدو مقاطع الفيديو الخاصة بك: واضحة وطبيعية وجاهزة للمشاركة.`,
    hi: (n) => `नमस्ते, मैं ${n} हूँ। आपके वीडियो ऐसे सुनाई दे सकते हैं: साफ़, स्वाभाविक और शेयर करने के लिए तैयार।`,
    ja: (n) => `こんにちは、${n}です。あなたの動画はこんなふうに聞こえます。はっきりと自然で、すぐにシェアできます。`,
};

const force = new Set((process.argv.find((a) => a.startsWith('--force='))?.slice(8) || '').split(',').filter(Boolean));

async function eleven(text, voiceId) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 } }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
}

async function openai(text, speaker, accent) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: speaker, input: text, instructions: accent || '', response_format: 'mp3' }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
}

let made = 0, chars = 0;
for (const v of voices) {
    if (v.legacy) continue;
    const file = join(out, `${v.id}.mp3`);
    if (existsSync(file) && !force.has(v.id)) continue;
    const text = (LINE[v.lang] || LINE.en)(v.name);
    try {
        const mp3 = v.elevenlabs ? await eleven(text, v.elevenlabs) : await openai(text, v.speaker, v.accent);
        writeFileSync(file, mp3);
        made++; if (v.elevenlabs) chars += text.length;
        console.log(`✓ ${v.id} (${Math.round(mp3.length / 1024)} KB)`);
    } catch (err) {
        console.error(`✗ ${v.id}: ${err.message}`);
        process.exitCode = 1;
    }
}
console.log(`\n${made} samples made, ${chars} ElevenLabs characters`);
