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
// and accent, so a voiceover is never lost — only its accent. Word timings use one path for both
// providers, and it times the words that were actually spoken.
//
// 2026-11-12 (docs/openai-audio-retirement-plan.md): OpenAI retires whisper-1 on 26 Feb 2027 and its
// replacement (gpt-transcribe) gives no word timestamps. Word timings now come from ElevenLabs Scribe
// (verbatim by default, so "um"s stay in for tightening; ~$0.0033/min). whisper-1 is used only when
// Scribe is not set up or refuses (e.g. the key lacks the Speech to Text permission), until it retires.
//
// Pure helpers are exported for tests; the two network calls never retry and throw TtsError.

export const TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
export const TRANSCRIBE_MODEL = 'whisper-1';
const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
/** ElevenLabs speech-to-text: word start/end times in one upload (files up to 5 GB). */
export const SCRIBE_MODEL = process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v3';
const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
export const ELEVENLABS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_multilingual_v2';
const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
/** USD per 1,000 characters: Starter is $6 for 40,000. Recheck when the plan changes. */
const ELEVENLABS_USD_PER_1K_CHARS = 0.15;

/** ~80 seconds of speech at a natural pace — longer than any short-form video needs. */
export const VOICEOVER_MAX_CHARS = 1200;

import CATALOGUE from '../public/voice-catalogue.json';

/**
 * The voices offered: src/public/voice-catalogue.json, the ONE list the server and the voice picker
 * (src/components/voice-picker.js) both read. Labels describe the sound, never a person. A voice with
 * an `elevenlabs` id is spoken by ElevenLabs; `speaker` (+ `accent`, an accent line for the delivery
 * note — gpt-4o-mini-tts takes accent from its instructions) is the OpenAI voice used if it fails, or
 * the only speaker when there is no ElevenLabs id. `legacy` voices (the original six OpenAI voices,
 * American-sounding) stay valid for saved settings but are no longer offered (owner, 2026-11-02:
 * "robotic … not human like at all"). Each voice speaks its own `lang`; the script decides the language.
 */
export interface Voice {
    id: string; name: string; label: string; gender: 'female' | 'male'; lang: string; region: string;
    elevenlabs?: string; speaker: string; accent?: string; legacy?: boolean;
}
export const VOICES: readonly Voice[] = (CATALOGUE as { voices: Voice[] }).voices;
export const VOICE_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = (CATALOGUE as { languages: Array<{ code: string; label: string }> }).languages;
export type VoiceId = string;
/** Pepper: the owner's pick for a British business's default (2026-11-02). */
export const DEFAULT_VOICE: VoiceId = 'british_woman';

/** The voices a customer can choose from (not legacy). */
export const OFFERED_VOICES: readonly Voice[] = VOICES.filter((v) => !v.legacy);

/** The language a voice speaks, by code ('en' when unknown). Pure. */
export function voiceLanguage(voice: VoiceId): string {
    return VOICES.find((v) => v.id === voice)?.lang ?? 'en';
}

/** The language's English name ("French"), or null. Pure. */
export function languageLabel(code: unknown): string | null {
    return VOICE_LANGUAGES.find((l) => l.code === code)?.label ?? null;
}

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
 * Words from a transcription: whisper's verbose_json (`word`) or Scribe's (`text`, with `type` —
 * only 'word' entries count; 'spacing' and 'audio_event' are dropped). Pure. Drops entries without
 * numeric times and keeps them in order; an empty list is valid (captions are then simply absent —
 * never invented).
 */
export function parseWords(payload: unknown): SpokenWord[] {
    const words = (payload as { words?: unknown[] } | null)?.words;
    if (!Array.isArray(words)) return [];
    return words
        .map((w) => w as { word?: unknown; text?: unknown; type?: unknown; start?: unknown; end?: unknown })
        .filter((w) => w.type === undefined || w.type === 'word')
        .map((w) => ({ word: typeof w.word === 'string' ? w.word : w.text, start: w.start, end: w.end }))
        .filter((w) => typeof w.word === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
        .map((w) => ({ word: String(w.word).trim(), start: Number(w.start), end: Math.max(Number(w.end), Number(w.start)) }))
        .filter((w) => w.word.length > 0)
        .sort((a, b) => a.start - b.start);
}

/** Seconds of audio: the provider's own duration (whisper `duration`, Scribe `audio_duration_secs`), else the last word's end. Pure. */
export function spokenDuration(payload: unknown, words: SpokenWord[]): number | null {
    const p = payload as { duration?: unknown; audio_duration_secs?: unknown } | null;
    const d = Number(p?.duration ?? p?.audio_duration_secs);
    if (Number.isFinite(d) && d > 0) return Math.round(d * 100) / 100;
    return words.length ? Math.round(words[words.length - 1].end * 100) / 100 : null;
}

export type TtsProvider = 'openai' | 'elevenlabs';

/** USD per minute of audio transcribed, list prices read 2026-11-12: Scribe $0.20/hour, whisper-1 $0.006/min. */
export const TRANSCRIBE_USD_PER_MINUTE: Record<TtsProvider, number> = { elevenlabs: 0.2 / 60, openai: 0.006 };

/**
 * List-price cost of one voiceover in USD: the speech (ElevenLabs per character, or OpenAI ~$0.015/min
 * of audio) + the transcription by whoever did it (TRANSCRIBE_USD_PER_MINUTE; null = it failed, so
 * nothing). Published list prices as last read; recheck when the bill disagrees. Pure.
 */
export function voiceoverCostUsd(durationS: number | null, spoken?: { provider: TtsProvider; chars: number }, transcribedBy: TtsProvider | null = 'openai'): string {
    const minutes = Math.max((durationS ?? 30) / 60, 1 / 60);
    const timing = transcribedBy ? minutes * TRANSCRIBE_USD_PER_MINUTE[transcribedBy] : 0;
    if (spoken?.provider === 'elevenlabs') return (spoken.chars / 1000 * ELEVENLABS_USD_PER_1K_CHARS + timing).toFixed(6);
    return (minutes * 0.015 + timing).toFixed(6);
}

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

/** What a transcription gives back: the words, the audio's length, and who heard it (for the cost line). */
export interface Transcript { words: SpokenWord[]; durationS: number | null; provider: TtsProvider }

/** Word timings + duration for an mp3. A failure here is NOT fatal to the voiceover — callers keep the audio. */
export async function transcribeWords(mp3: Buffer, fetchImpl: typeof fetch = fetch): Promise<Transcript> {
    return transcribeAudio(mp3, { filename: 'voiceover.mp3', type: 'audio/mpeg' }, fetchImpl);
}

export interface TranscribeOptions {
    filename: string; type: string; timeoutMs?: number;
    /** ISO-639-1 ('en'). Said, not guessed: left to detect the language, whisper heard an English
     *  speaker as Welsh and got every word time wrong with it (footage review on staging, 2026-11-09). */
    language?: string;
    /** whisper only: text it is primed with (Scribe takes no prompt and is verbatim already). */
    prompt?: string;
    /** Scribe only: names and terms it should spell right (e.g. the business name). */
    keyterms?: string[];
}

/**
 * Word timings for any audio: ElevenLabs Scribe first, whisper-1 when Scribe is not set up or refuses
 * (key, permission, credits, a bad answer). A Scribe timeout is NOT retried on whisper — a second wait
 * could outlast the request — and every caller already treats a failed transcription as "no words".
 * Throws TtsError when neither can be used.
 */
export async function transcribeAudio(bytes: Buffer, file: TranscribeOptions, fetchImpl: typeof fetch = fetch): Promise<Transcript> {
    if (process.env.ELEVENLABS_API_KEY) {
        try {
            return await transcribeScribe(bytes, file, fetchImpl);
        } catch (err) {
            const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
            if (timedOut || !process.env.OPENAI_API_KEY) throw err;
            console.warn('[tts] Scribe failed — transcribing with whisper instead:', err instanceof Error ? err.message : err);
        }
    }
    return transcribeWhisper(bytes, file, fetchImpl);
}

/** Scribe's keyterms: one line each, no angle brackets, 1–50 characters, no repeats, at most 20. Pure. */
export function scribeKeyterms(terms: readonly unknown[] | undefined): string[] {
    return [...new Set((terms ?? [])
        .map((t) => (typeof t === 'string' ? t.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() : ''))
        .filter((t) => t.length > 0 && t.length <= 50))].slice(0, 20);
}

/** ElevenLabs Scribe: verbatim (fillers kept), no audio-event tags, word timestamps. */
export async function transcribeScribe(bytes: Buffer, file: TranscribeOptions, fetchImpl: typeof fetch = fetch): Promise<Transcript> {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new TtsError('ElevenLabs is not configured.', 'not_configured');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: file.type }), file.filename);
    form.append('model_id', SCRIBE_MODEL);
    if (file.language) form.append('language_code', file.language);
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    form.append('no_verbatim', 'false');
    for (const term of scribeKeyterms(file.keyterms)) form.append('keyterms', term);
    const res = await fetchImpl(SCRIBE_URL, {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
        signal: AbortSignal.timeout(file.timeoutMs ?? 8_000),
    });
    if (!res.ok) throw classifyElevenLabs(res.status, await res.text().catch(() => ''));
    const payload = await res.json();
    const words = parseWords(payload);
    return { words, durationS: spokenDuration(payload, words), provider: 'elevenlabs' };
}

/**
 * whisper-1 (≤ 25 MB) — the fallback until OpenAI retires it on 26 Feb 2027. The owner's footage
 * arrives as a 16 kHz mono WAV the browser made (src/components/footage-reader.js), ~10 MB for five
 * minutes, so it gets longer.
 */
export async function transcribeWhisper(bytes: Buffer, file: TranscribeOptions, fetchImpl: typeof fetch = fetch): Promise<Transcript> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new TtsError('Voiceovers are not configured.', 'not_configured');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: file.type }), file.filename);
    if (file.language) form.append('language', file.language);
    if (file.prompt) form.append('prompt', file.prompt.slice(0, 600));
    form.append('model', TRANSCRIBE_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    const res = await fetchImpl(TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(file.timeoutMs ?? 8_000),
    });
    if (!res.ok) throw classify(res.status, await res.text().catch(() => ''));
    const payload = await res.json();
    const words = parseWords(payload);
    return { words, durationS: spokenDuration(payload, words), provider: 'openai' };
}
