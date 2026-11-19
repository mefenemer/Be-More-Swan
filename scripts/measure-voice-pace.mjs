// scripts/measure-voice-pace.mjs — how fast each voice in src/public/voice-catalogue.json really speaks.
//
// Phase 4c follow-up (staging project 51, 2026-11-19): the planner wrote 302 words for a 2-minute video at an assumed
// 2.5 words a second, and Priya's voice spoke them in 84 s (~3.6 a second). A long video's word target now comes from
// the chosen voice's measured pace. This speaks one voiceover-style paragraph per voice in its own language, measures
// the audio, and writes `wps` (words per second, whitespace words) onto each voice. Japanese has no spaces between
// words, so a words-a-second figure means nothing there: it is left out (callers fall back to WORDS_PER_SECOND).
//
// Run (costs about $4 at ElevenLabs for every voice; secrets from the environment, never printed):
//   ELEVENLABS_API_KEY=… OPENAI_API_KEY=… node scripts/measure-voice-pace.mjs [--write] [--only=id1,id2]
// Needs ffprobe on PATH. Without --write it only prints.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const CATALOGUE = 'src/public/voice-catalogue.json';
const WRITE = process.argv.includes('--write');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

// One paragraph per language, written like a Video Producer voiceover: short spoken sentences, a few numbers.
const TEXT = {
    en: 'Want a short film about your business? Here is how we make one. First, we have a free call. We ask what you do, who your customers are, and how you want people to feel. Next, we write a simple plan. It lists every scene and what is said in it. You can change anything before we film. On filming day, we bring the cameras and the lights, and we work around your opening hours. Then we edit. We add music and captions, and you get two rounds of changes. A one minute film starts at nine hundred and fifty pounds. To book your free call, visit our website today.',
    fr: "Vous voulez un court film sur votre entreprise ? Voici comment nous le réalisons. D'abord, un appel gratuit. Nous vous demandons ce que vous faites, qui sont vos clients et ce que vous voulez faire ressentir. Ensuite, nous écrivons un plan simple. Il liste chaque scène et ce qui y est dit. Vous pouvez tout changer avant le tournage. Le jour du tournage, nous apportons les caméras et les lumières, et nous respectons vos horaires. Puis nous montons le film. Nous ajoutons la musique et les sous-titres, et vous avez deux séries de modifications. Un film d'une minute commence à neuf cent cinquante livres. Pour réserver votre appel gratuit, rendez-vous sur notre site.",
    de: 'Sie möchten einen kurzen Film über Ihr Unternehmen? So entsteht er. Zuerst führen wir ein kostenloses Gespräch. Wir fragen, was Sie tun, wer Ihre Kunden sind und welches Gefühl der Film wecken soll. Danach schreiben wir einen einfachen Plan. Er zeigt jede Szene und was darin gesagt wird. Sie können alles ändern, bevor wir drehen. Am Drehtag bringen wir Kameras und Licht mit und richten uns nach Ihren Öffnungszeiten. Dann schneiden wir den Film. Wir fügen Musik und Untertitel hinzu, und Sie bekommen zwei Korrekturrunden. Ein Film von einer Minute beginnt bei neunhundertfünfzig Pfund. Buchen Sie Ihr kostenloses Gespräch auf unserer Website.',
    es: '¿Quiere un vídeo corto sobre su negocio? Así lo hacemos. Primero, una llamada gratuita. Le preguntamos a qué se dedica, quiénes son sus clientes y qué quiere que sienta la gente. Después, escribimos un plan sencillo. Incluye cada escena y lo que se dice en ella. Puede cambiar cualquier cosa antes de grabar. El día de la grabación llevamos las cámaras y las luces, y nos adaptamos a su horario. Luego editamos. Añadimos música y subtítulos, y tiene dos rondas de cambios. Un vídeo de un minuto empieza en novecientas cincuenta libras. Para reservar su llamada gratuita, visite nuestra web hoy.',
    it: "Vuole un breve video sulla sua attività? Ecco come lo realizziamo. Prima, una chiamata gratuita. Le chiediamo di cosa si occupa, chi sono i suoi clienti e cosa vuole far provare alle persone. Poi scriviamo un piano semplice. Elenca ogni scena e cosa viene detto. Può cambiare tutto prima delle riprese. Il giorno delle riprese portiamo telecamere e luci, e rispettiamo i suoi orari. Poi montiamo il video. Aggiungiamo musica e sottotitoli, e lei ha due giri di modifiche. Un video di un minuto parte da novecentocinquanta sterline. Per prenotare la chiamata gratuita, visiti il nostro sito oggi.",
    pt: 'Quer um filme curto sobre o seu negócio? É assim que o fazemos. Primeiro, uma chamada gratuita. Perguntamos o que faz, quem são os seus clientes e o que quer que as pessoas sintam. Depois, escrevemos um plano simples. Mostra cada cena e o que se diz nela. Pode mudar tudo antes das filmagens. No dia das filmagens, levamos as câmaras e as luzes, e respeitamos o seu horário. Depois editamos. Juntamos música e legendas, e tem duas rondas de alterações. Um filme de um minuto começa nas novecentas e cinquenta libras. Para marcar a sua chamada gratuita, visite hoje o nosso site.',
    nl: 'Wilt u een korte film over uw bedrijf? Zo maken we die. Eerst voeren we een gratis gesprek. We vragen wat u doet, wie uw klanten zijn en wat mensen moeten voelen. Daarna schrijven we een eenvoudig plan. Het noemt elke scène en wat erin gezegd wordt. U kunt alles veranderen voordat we filmen. Op de filmdag nemen we camera’s en lampen mee, en we houden rekening met uw openingstijden. Dan monteren we. We voegen muziek en ondertitels toe, en u krijgt twee rondes aanpassingen. Een film van één minuut begint bij negenhonderdvijftig pond. Boek uw gratis gesprek vandaag op onze website.',
    pl: 'Chcesz krótki film o swojej firmie? Oto jak go robimy. Najpierw bezpłatna rozmowa. Pytamy, czym się zajmujesz, kim są twoi klienci i co ludzie mają poczuć. Potem piszemy prosty plan. Zawiera każdą scenę i to, co w niej pada. Możesz wszystko zmienić przed nagraniem. W dniu zdjęć przywozimy kamery i światła, a pracujemy w twoich godzinach otwarcia. Potem montujemy. Dodajemy muzykę i napisy, a ty dostajesz dwie rundy poprawek. Film jednominutowy kosztuje od dziewięciuset pięćdziesięciu funtów. Aby umówić bezpłatną rozmowę, odwiedź dziś naszą stronę.',
    ar: 'هل تريد فيلما قصيرا عن عملك؟ هكذا نصنعه. أولا، مكالمة مجانية. نسألك عما تفعله، ومن هم عملاؤك، وما الذي تريد أن يشعر به الناس. بعد ذلك نكتب خطة بسيطة. تذكر كل مشهد وما يقال فيه. يمكنك تغيير أي شيء قبل التصوير. في يوم التصوير نحضر الكاميرات والإضاءة، ونعمل حسب ساعات عملك. ثم نقوم بالمونتاج. نضيف الموسيقى والترجمة، ولديك جولتان من التعديلات. يبدأ سعر الفيلم المكون من دقيقة واحدة من تسعمئة وخمسين جنيها. لحجز مكالمتك المجانية، زر موقعنا اليوم.',
    hi: 'क्या आप अपने व्यवसाय पर एक छोटी फ़िल्म चाहते हैं? हम इसे ऐसे बनाते हैं। पहले, एक मुफ़्त कॉल। हम पूछते हैं कि आप क्या करते हैं, आपके ग्राहक कौन हैं, और लोग क्या महसूस करें। फिर हम एक आसान योजना लिखते हैं। इसमें हर दृश्य और उसमें कही जाने वाली बात होती है। शूटिंग से पहले आप कुछ भी बदल सकते हैं। शूटिंग के दिन हम कैमरे और लाइटें लाते हैं, और आपके समय के हिसाब से काम करते हैं। फिर हम एडिट करते हैं। हम संगीत और कैप्शन जोड़ते हैं, और आपको दो बार बदलाव का मौका मिलता है। एक मिनट की फ़िल्म नौ सौ पचास पाउंड से शुरू होती है। मुफ़्त कॉल बुक करने के लिए आज ही हमारी वेबसाइट देखें।',
};

const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'voice-pace-'));
const words = (t) => t.split(/\s+/).filter(Boolean).length;

async function speak(v, text) {
    if (v.elevenlabs) {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.elevenlabs}?output_format=mp3_44100_128`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
            body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 } }),
        });
        if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: v.speaker || v.id, input: text, response_format: 'mp3' }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/** Seconds of speech: the file's length less leading and trailing silence. */
function speechSpan(file) {
    const total = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
    const err = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=n=-45dB:d=0.25', '-f', 'null', '-']).stderr.toString();
    const starts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
    let from = 0, to = total;
    if (starts.length && starts[0] < 0.05 && ends.length) from = ends[0];
    if (starts.length && starts[starts.length - 1] > total - 1.5 && (ends.length < starts.length || ends[ends.length - 1] >= total - 0.05)) to = starts[starts.length - 1];
    return Math.max(0.5, to - from);
}

const results = [];
for (const v of catalogue.voices) {
    if (ONLY.length && !ONLY.includes(v.id)) continue;
    const text = TEXT[v.lang];
    if (!text) { results.push({ id: v.id, lang: v.lang, skipped: 'no words-a-second for this language' }); continue; }
    try {
        const file = join(dir, `${v.id}.mp3`);
        writeFileSync(file, await speak(v, text));
        const secs = speechSpan(file);
        const wps = Math.round((words(text) / secs) * 100) / 100;
        results.push({ id: v.id, lang: v.lang, words: words(text), seconds: Math.round(secs * 10) / 10, wps });
        if (WRITE) v.wps = wps;
    } catch (err) {
        results.push({ id: v.id, lang: v.lang, error: err.message });
    }
    console.log(JSON.stringify(results[results.length - 1]));
}
if (WRITE) {
    catalogue._about = String(catalogue._about || '').includes('wps') ? catalogue._about
        : `${catalogue._about || ''} "wps": measured words a second (scripts/measure-voice-pace.mjs), used for a long video's word target.`.trim();
    writeFileSync(CATALOGUE, JSON.stringify(catalogue, null, 2) + '\n');
    console.log(`wrote wps onto ${results.filter((r) => r.wps).length} voices`);
}
