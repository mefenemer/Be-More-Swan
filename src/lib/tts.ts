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
//
// Pure helpers are exported for tests; the two network calls never retry and throw TtsError.

export const TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
export const TRANSCRIBE_MODEL = 'whisper-1';
const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** ~80 seconds of speech at a natural pace — longer than any short-form video needs. */
export const VOICEOVER_MAX_CHARS = 1200;

/**
 * The voices offered. A short, labelled list on purpose: eleven unnamed voices is a choice nobody
 * can make. Keys are OpenAI voice ids; labels describe the sound, never a person.
 */
export const VOICES = [
    { id: 'coral',   label: 'Warm and friendly' },
    { id: 'sage',    label: 'Calm and clear' },
    { id: 'verse',   label: 'Bright and upbeat' },
    { id: 'alloy',   label: 'Neutral and steady' },
    { id: 'onyx',    label: 'Deep and confident' },
    { id: 'shimmer', label: 'Light and lively' },
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
export function voiceoverCostUsd(durationS: number | null): string {
    const minutes = Math.max((durationS ?? 30) / 60, 1 / 60);
    return (minutes * (0.015 + 0.006)).toFixed(6);
}

function classify(status: number, body: string): TtsError {
    if (status === 401 || status === 403) return new TtsError(`OpenAI rejected the key (HTTP ${status})`, 'key');
    if (status === 429 && /insufficient_quota|exceeded your current quota|billing/i.test(body)) return new TtsError('OpenAI quota exhausted', 'quota');
    if (status === 400 && /safety|policy|moderation/i.test(body)) return new TtsError('OpenAI refused the text', 'policy');
    return new TtsError(`OpenAI HTTP ${status}: ${body.slice(0, 200)}`);
}

/** Speak `text` in `voice`. Returns mp3 bytes. */
export async function synthesizeSpeech(text: string, voice: VoiceId, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new TtsError('Voiceovers are not configured.', 'not_configured');
    const res = await fetchImpl(SPEECH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: TTS_MODEL, voice, input: text, instructions: VOICEOVER_INSTRUCTIONS, response_format: 'mp3' }),
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
