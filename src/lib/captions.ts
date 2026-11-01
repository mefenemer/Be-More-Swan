// src/lib/captions.ts
//
// Burned-in captions for voiceovers (Video Producer plan, Phase 3). Most short-form video is watched
// with the sound off; a voiceover nobody hears is a video with nothing said.
//
// ── Where the words come from ───────────────────────────────────────────────────────────────────
// generate-voiceover.ts transcribes its own audio with word timestamps and stores them on the asset
// (content_assets.render_params = { kind: 'voiceover', words }). Captions are built ONLY from those
// spoken words, never from the script that was asked for: if the transcription failed, there are no
// words and no captions — a caption of a word that was never said is worse than none.
//
// ── The shape ───────────────────────────────────────────────────────────────────────────────────
// Short phrases (≤ 4 words / 26 characters, broken early at sentence ends and pauses), one on screen
// at a time, the word being spoken picked out in an accent colour. Timed on the post's timeline:
// a voiceover placed at 3 s puts its first word at 3 s + that word's own start.
//
// PURE and browser-safe: the Remotion bundle imports it (remotion/PostOverlay.tsx), so no Node
// imports here, ever — the same rule as overlay-geometry.ts.

export interface SpokenWordLike { word: string; start: number; end: number }

/** One voiceover on the timeline: where it plays and what it says. */
export interface CaptionSource {
    startS?: number;
    endS?: number;
    words: SpokenWordLike[];
}

export interface CaptionWord { text: string; startS: number; endS: number }
export interface CaptionCue { startS: number; endS: number; words: CaptionWord[] }

/** What the composition receives. */
export interface CaptionTrack { cues: CaptionCue[]; accent?: string }

export const CAPTION_MAX_WORDS = 4;
export const CAPTION_MAX_CHARS = 26;
/** How long a phrase stays after its last word, unless the next phrase starts sooner. */
export const CAPTION_HOLD_S = 0.4;
/** A silence this long starts a new phrase even mid-sentence. */
export const CAPTION_PAUSE_S = 0.6;
/** The overlay font id captions use — Impact, rendered as Anton (overlay-fonts.ts). */
export const CAPTION_FONT_ID = 'Impact';
/** The highlight when the brand colour would not read on video. */
export const CAPTION_FALLBACK_ACCENT = '#FFD400';

const SENTENCE_END = /[.!?…]$|[,;:]$/;

const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Put the script's punctuation back on the transcribed words. Whisper's word timings come back bare
 * ("breakdowns", not "breakdowns."), so the sentence-end break above never fired and a caption ran
 * across two sentences ("breakdowns Brightside", the first sample render, 2026-11-01). The script is
 * what was spoken, so each word takes the matching script token's spelling — matched in order, and
 * only when the letters agree, so a word the speaker said differently keeps its own text. Pure.
 */
export function withScriptPunctuation<W extends { word: string }>(words: W[], script: string | null | undefined): W[] {
    const tokens = String(script ?? '').split(/\s+/).filter(Boolean);
    if (!tokens.length) return words;
    let j = 0;
    return words.map((w) => {
        const want = bare(w.word);
        if (!want) return w;
        // Look a few tokens ahead: the transcript can drop or merge a word.
        for (let k = j; k < Math.min(tokens.length, j + 4); k++) {
            if (bare(tokens[k]) === want) { j = k + 1; return { ...w, word: tokens[k] }; }
        }
        return w;
    });
}

/** Words placed on the timeline, cut at each voiceover's own end. Pure. */
export function timelineWords(sources: CaptionSource[]): CaptionWord[] {
    const out: CaptionWord[] = [];
    for (const src of sources) {
        const offset = src.startS ?? 0;
        for (const w of src.words || []) {
            if (!w || typeof w.word !== 'string' || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
            const text = w.word.trim();
            if (!text) continue;
            const startS = offset + w.start;
            let endS = offset + Math.max(w.end, w.start);
            if (src.endS != null) {
                if (startS >= src.endS) continue;     // the clip is cut before this word is heard
                endS = Math.min(endS, src.endS);
            }
            out.push({ text, startS, endS });
        }
    }
    return out.sort((a, b) => a.startS - b.startS);
}

/** Group words into on-screen phrases. Pure. */
export function buildCaptionCues(sources: CaptionSource[]): CaptionCue[] {
    const words = timelineWords(sources);
    const cues: CaptionCue[] = [];
    let cur: CaptionWord[] = [];
    let chars = 0;
    const flush = () => {
        if (!cur.length) return;
        cues.push({ startS: cur[0].startS, endS: cur[cur.length - 1].endS, words: cur });
        cur = []; chars = 0;
    };
    for (const w of words) {
        const prev = cur[cur.length - 1];
        const breakBefore = !!prev && (
            cur.length >= CAPTION_MAX_WORDS
            || chars + 1 + w.text.length > CAPTION_MAX_CHARS
            || SENTENCE_END.test(prev.text)
            || w.startS - prev.endS > CAPTION_PAUSE_S
        );
        if (breakBefore) flush();
        cur.push(w);
        chars += (cur.length > 1 ? 1 : 0) + w.text.length;
    }
    flush();
    // Hold each phrase a moment after its last word, but never over the next one.
    for (let i = 0; i < cues.length; i++) {
        const next = cues[i + 1];
        const held = cues[i].endS + CAPTION_HOLD_S;
        cues[i].endS = next ? Math.max(cues[i].endS, Math.min(held, next.startS)) : held;
    }
    return cues;
}

/** The phrase on screen at `t` seconds, and which of its words is being spoken (-1 between words). Pure. */
export function cueAt(cues: CaptionCue[], t: number): { cue: CaptionCue; wordIndex: number } | null {
    for (const cue of cues) {
        if (t >= cue.startS && t < cue.endS) {
            let wordIndex = -1;
            for (let i = 0; i < cue.words.length; i++) {
                if (t >= cue.words[i].startS) wordIndex = i;
            }
            return { cue, wordIndex };
        }
    }
    return null;
}

/**
 * The highlight colour: the brand's own when it is bright enough to read over footage, else yellow.
 * A dark brand colour (plenty are near-black) would make the spoken word VANISH, not stand out. Pure.
 */
export function captionAccent(hex: string | null | undefined): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return CAPTION_FALLBACK_ACCENT;
    const n = parseInt(m[1], 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance >= 0.35 ? `#${m[1].toUpperCase()}` : CAPTION_FALLBACK_ACCENT;
}

/** Caption box geometry for a frame `height` px tall. Shared by the render and any preview. Pure. */
export function captionLayout(height: number): { fontSizePx: number; bottomPct: number; sidePct: number; strokePx: number } {
    return {
        fontSizePx: Math.round(height * 0.058),
        // Above the lower ~18 % where Reels/Shorts/TikTok draw their own caption and buttons.
        bottomPct: 21,
        sidePct: 7,
        strokePx: Math.max(2, Math.round(height * 0.004)),
    };
}
