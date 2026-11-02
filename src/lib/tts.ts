// src/lib/tts.ts
// Customer voiceovers (Video Producer plan, Phase 2) — OpenAI text-to-speech, then a transcription
// pass for word timings.
//
// ── Why two calls ───────────────────────────────────────────────────────────────────────────────
// OpenAI's speech endpoint returns audio and nothing else: no duration, no word timings. Captions
// (Phase 3) need to know when each word is spoken, and the video timeline needs the clip's length
// without measuring it in a browser (content_assets.durationS is NULL for most assets, and a control
// drawn against a failed measurement silently vanishes). So the audio goes straight back through
// whisper-1 with word timestamps. That costs ~$0.006 a minute and gives both facts from the audio
// itself — the words we asked for are not proof of the words that were spoken.
//
// The owner chose OpenAI over ElevenLabs on 2026-10-31: the key is already in use (guided tour), so
// no new bill or balance. check-provider-balances probes it (provider-balance.ts probeOpenAi).
// 2026-11-02: OpenAI could not sound like a British woman however the accent was described, so a
// voice with an `elevenlabs` id is spoken by ElevenLabs (ELEVENLABS_API_KEY; ~3–6p a voiceover, the
// owner kept it inside the 1-task weight). Any ElevenLabs failure falls back to the OpenAI speaker
// and accent, so a voiceover is never lost — only its accent. Word timings stay with whisper for
// both providers: one timing path, and it times the words that were actually spoken.
//
// Pure helpers are exported for tests; the two network calls never retry and throw TtsError.

export const TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
export const TRANSCRIBE_MODEL = 'whisper-1';
const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const ELEVENLABS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_multilingual_v2';
const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
/** USD per 1,000 characters: Starter is $6 for 40,000. Recheck when the plan changes. */
const ELEVENLABS_USD_PER_1K_CHARS = 0.15;

/** ~80 seconds of speech at a natural pace — longer than any short-form video needs. */
export const VOICEOVER_MAX_CHARS = 1200;

/**
 * The voices offered. A short, labelled list on purpose: eleven unnamed voices is a choice nobody
 * can make. Labels describe the sound, never a person. The first six ids ARE OpenAI voice ids; an
 * accented voice is an OpenAI voice (`speaker`) plus an accent line added to the delivery note —
 * gpt-4o-mini-tts takes accent from its instructions. The owner asked for British voices for the
 * website samples (2026-11-02): OpenAI's voices are American-sounding without one.
 * src/components/assistant-videos.js and the onboarding schema list the same ids (tests/tts-voices.test.ts).
 */
export const VOICES = [
    { id: 'coral',   label: 'Warm and friendly' },
    { id: 'sage',    label: 'Calm and clear' },
    { id: 'verse',   label: 'Bright and upbeat' },
    { id: 'alloy',   label: 'Neutral and steady' },
    { id: 'onyx',    label: 'Deep and confident' },
    { id: 'shimmer', label: 'Light and lively' },
    // ElevenLabs "Pepper", picked by ear (2026-11-02) after ten OpenAI women all came back American:
    // a real British speaker, not an accent asked for. coral + accent is only the fallback.
    { id: 'british_woman', label: 'British, warm (woman)', speaker: 'coral', elevenlabs: '6vIP9mPY4dr6w8krUg01',
      accent: 'Speak with a natural British English accent, as a woman from the south of England: warm and friendly, not posh.' },
    // ElevenLabs "Beth - British female, playful & witty", the owner's pick for the Harbour Yoga sample
    // (2026-11-02). Same coral + accent fallback as Pepper.
    { id: 'british_woman_playful', label: 'British, playful (woman)', speaker: 'coral', elevenlabs: 'zH7TN9vEZAsEway9xWev',
      accent: 'Speak with a natural British English accent, as a young woman from the south of England: playful, witty and warm, not posh.' },
    // Ballad, picked by ear from four trials (2026-11-02): the accent needs spelling out — a one-line
    // "London accent" note came back American.
    { id: 'london_man', label: 'London, laid-back (man)', speaker: 'ballad',
      accent: 'Accent: a strong, authentic London accent, Estuary English / modern working-class London, like a friendly young bloke from South or East London. Drop the H at the start of words ("\'arbour"), use glottal stops for T in the middle and end of words ("ge\'", "wha\'", "le\'s"), TH-fronting where it sounds natural ("fings", "wiv"), and London vowels ("toDAI" for today, "noime" for name). Relaxed, streetwise, cheeky and warm. Not posh, not BBC English, not American, never a cartoon Cockney.' },
] as const;
export type VoiceId = typeof VOICES[number]['id'];
export const DEFAULT_VOICE: VoiceId = 'coral';

export function isVoiceId(v: unknown): v is VoiceId {
    return typeof v === 'string' && VOICES.some((x) => x.id === v);
}

/** Delivery note sent with every voiceover: an advert read, not an audiobook. */
export const VOICEOVER_INSTRUCTIONS =
    'Read this as a short promotional video voiceover for a small business: natural, warm and confident, '
    + 'conversational pace, clear diction, a little energy on the opening line. Not a monotone, not over-acted.';

/** One spoken word and when it is heard, in seconds from the start of the voiceover. */
export interface SpokenWord { word: string; start: number; end: number }

export class TtsError extends Error {
    constructor(message: string, readonly kind: 'not_configured' | 'quota' | 'key' | 'policy' | 'failed' = 'failed') {
        super(message);
        this.name = 'TtsError';
    }
}

/** Tidy a script for speech. Pure: collapses whitespace, strips markdown and URLs (read aloud they are noise). */
export function cleanScript(text: string): string {
    return String(text || '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[*_#`>~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, VOICEOVER_MAX_CHARS);
}

/**
 * Words from whisper's verbose_json. Pure. Drops entries without numeric times and keeps them in
 * order; an empty list is valid (captions are then simply absent — never invented).
 */
export function parseWords(payload: unknown): SpokenWord[] {
    const words = (payload as { words?: unknown[] } | null)?.words;
    if (!Array.isArray(words)) return [];
    return words
        .map((w) => w as { word?: unknown; start?: unknown; end?: unknown })
        .filter((w) => typeof w.word === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
        .map((w) => ({ word: String(w.word).trim(), start: Number(w.start), end: Math.max(Number(w.end), Number(w.start)) }))
        .filter((w) => w.word.length > 0)
        .sort((a, b) => a.start - b.start);
}

/** Seconds of audio: whisper's own duration, else the last word's end. Pure. */
export function spokenDuration(payload: unknown, words: SpokenWord[]): number | null {
    const d = Number((payload as { duration?: unknown } | null)?.duration);
    if (Number.isFinite(d) && d > 0) return Math.round(d * 100) / 100;
    return words.length ? Math.round(words[words.length - 1].end * 100) / 100 : null;
}

/**
 * List-price cost of one voiceover in USD: speech ~$0.015/min of audio + transcription $0.006/min
 * (OpenAI's published per-minute estimates as last read; recheck when the bill disagrees). Pure.
 */
export function voiceoverCostUsd(durationS: number | null, spoken?: { provider: TtsProvider; chars: number }): string {
    const minutes = Math.max((durationS ?? 30) / 60, 1 / 60);
    if (spoken?.provider === 'elevenlabs') return (spoken.chars / 1000 * ELEVENLABS_USD_PER_1K_CHARS + minutes * 0.006).toFixed(6);
    return (minutes * (0.015 + 0.006)).toFixed(6);
}

export type TtsProvider = 'openai' | 'elevenlabs';

/** The ElevenLabs voice id for one of our voices, or null when OpenAI speaks it. Pure. */
export function elevenLabsVoice(voice: VoiceId): string | null {
    const v = VOICES.find((x) => x.id === voice) as { elevenlabs?: string } | undefined;
    return v?.elevenlabs ?? null;
}

function classifyElevenLabs(status: number, body: string): TtsError {
    if (status === 401 || status === 403) return new TtsError(`ElevenLabs rejected the key (HTTP ${status})`, 'key');
    if (/quota_exceeded|insufficient|credits/i.test(body)) return new TtsError('ElevenLabs credits exhausted', 'quota');
    return new TtsError(`ElevenLabs HTTP ${status}: ${body.slice(0, 200)}`);
}

/** Speak `text` with an ElevenLabs voice. Returns mp3 bytes. */
export async function synthesizeElevenLabs(text: string, voiceId: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new TtsError('ElevenLabs is not configured.', 'not_configured');
    const res = await fetchImpl(`${ELEVENLABS_URL}/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
        // Settings the owner heard in the trials: a little expressive, true to the speaker.
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2 } }),
        // Short enough that the OpenAI fallback still fits inside the request.
        signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw classifyElevenLabs(res.status, await res.text().catch(() => ''));
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Speak a voiceover with whichever provider owns the voice, falling back to OpenAI when ElevenLabs
 * is missing or fails. Returns the audio and who made it, for the job row and the cost line.
 */
export async function speakVoiceover(text: string, voice: VoiceId, fetchImpl: typeof fetch = fetch): Promise<{ mp3: Buffer; provider: TtsProvider; model: string }> {
    const eleven = elevenLabsVoice(voice);
    if (eleven && process.env.ELEVENLABS_API_KEY) {
        try {
            return { mp3: await synthesizeElevenLabs(text, eleven, fetchImpl), provider: 'elevenlabs', model: ELEVENLABS_MODEL };
        } catch (err) {
            console.warn('[tts] ElevenLabs failed — speaking with OpenAI instead:', err instanceof Error ? err.message : err);
        }
    }
    return { mp3: await synthesizeSpeech(text, voice, fetchImpl), provider: 'openai', model: TTS_MODEL };
}

function classify(status: number, body: string): TtsError {
    if (status === 401 || status === 403) return new TtsError(`OpenAI rejected the key (HTTP ${status})`, 'key');
    if (status === 429 && /insufficient_quota|exceeded your current quota|billing/i.test(body)) return new TtsError('OpenAI quota exhausted', 'quota');
    if (status === 400 && /safety|policy|moderation/i.test(body)) return new TtsError('OpenAI refused the text', 'policy');
    return new TtsError(`OpenAI HTTP ${status}: ${body.slice(0, 200)}`);
}

/** The OpenAI voice and delivery note for one of our voices. Pure. */
export function voiceRequest(voice: VoiceId): { speaker: string; instructions: string } {
    const v = VOICES.find((x) => x.id === voice) as { id: string; speaker?: string; accent?: string } | undefined;
    return {
        speaker: v?.speaker ?? voice,
        instructions: v?.accent ? `${VOICEOVER_INSTRUCTIONS} ${v.accent}` : VOICEOVER_INSTRUCTIONS,
    };
}

/** Speak `text` in `voice`. Returns mp3 bytes. */
export async function synthesizeSpeech(text: string, voice: VoiceId, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new TtsError('Voiceovers are not configured.', 'not_configured');
    const { speaker, instructions } = voiceRequest(voice);
    const res = await fetchImpl(SPEECH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: TTS_MODEL, voice: speaker, input: text, instructions, response_format: 'mp3' }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw classify(res.status, await res.text().catch(() => ''));
    return Buffer.from(await res.arrayBuffer());
}

/** Word timings + duration for an mp3. A failure here is NOT fatal to the voiceover — callers keep the audio. */
export async function transcribeWords(mp3: Buffer, fetchImpl: typeof fetch = fetch): Promise<{ words: SpokenWord[]; durationS: number | null }> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new TtsError('Voiceovers are not configured.', 'not_configured');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(mp3)], { type: 'audio/mpeg' }), 'voiceover.mp3');
    form.append('model', TRANSCRIBE_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    const res = await fetchImpl(TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw classify(res.status, await res.text().catch(() => ''));
    const payload = await res.json();
    const words = parseWords(payload);
    return { words, durationS: spokenDuration(payload, words) };
}
