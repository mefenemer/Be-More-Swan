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

/**
 * How the captions look — chosen per voiceover in the post editor (the voiceover's row) and per
 * assistant for the Video Producer (setup `captionStyle`). Absent = DEFAULT_CAPTION_STYLE, which is
 * exactly how captions looked before styles existed, so an old post renders unchanged.
 *   mode       'highlight' — short phrases, the spoken word in the highlight colour (the original)
 *              'phrase'    — longer phrases, no highlight
 *              'word'      — one word at a time, large
 *   highlight  'brand' (the brand colour when it reads over footage, captionAccent) or a #hex
 *   box        a dark band behind the words, for busy footage
 */
export type CaptionMode = 'highlight' | 'phrase' | 'word';
export type CaptionPosition = 'bottom' | 'middle' | 'top';
export type CaptionSize = 'small' | 'medium' | 'large';
export interface CaptionStyle {
    mode: CaptionMode; position: CaptionPosition; size: CaptionSize;
    font: string; textColor: string; highlight: string; box: boolean;
}

/** What the composition receives. `style` absent on renders queued before styles existed. */
export interface CaptionTrack { cues: CaptionCue[]; accent?: string; style?: CaptionStyle }

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

/** The caption faces offered — overlay-fonts.ts ids the render already loads. */
export const CAPTION_FONTS = ['Impact', 'Arial', 'Georgia', 'Trebuchet MS', 'Verdana', 'Comic Sans MS'] as const;

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
    mode: 'highlight', position: 'bottom', size: 'medium', font: CAPTION_FONT_ID, textColor: '#FFFFFF', highlight: 'brand', box: false,
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Whatever the client or a setup answer sent → a valid style; anything unknown falls back. Pure. */
export function normalizeCaptionStyle(raw: unknown): CaptionStyle {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed as readonly unknown[]).includes(v) ? v as T : d;
    const d = DEFAULT_CAPTION_STYLE;
    return {
        mode: pick(o.mode, ['highlight', 'phrase', 'word'] as const, d.mode),
        position: pick(o.position, ['bottom', 'middle', 'top'] as const, d.position),
        size: pick(o.size, ['small', 'medium', 'large'] as const, d.size),
        font: pick(o.font, CAPTION_FONTS, d.font as typeof CAPTION_FONTS[number]),
        textColor: typeof o.textColor === 'string' && HEX.test(o.textColor) ? o.textColor.toUpperCase() : d.textColor,
        highlight: o.highlight === 'brand' ? 'brand' : typeof o.highlight === 'string' && HEX.test(o.highlight) ? o.highlight.toUpperCase() : d.highlight,
        box: o.box === true,
    };
}

/** Words and characters a phrase may hold, by mode. Pure. */
export function captionLimits(mode: CaptionMode): { words: number; chars: number } {
    if (mode === 'word') return { words: 1, chars: 40 };
    if (mode === 'phrase') return { words: 7, chars: 42 };
    return { words: CAPTION_MAX_WORDS, chars: CAPTION_MAX_CHARS };
}

const SENTENCE_END = /[.!?…]$|[,;:]$/;

const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Edit distance, capped: true when a and b are within `max` single-letter edits. Pure. */
function near(a: string, b: string, max: number): boolean {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length] <= max;
}

/** The same word, allowing a spelling difference in a longer word ("Harbor" for the script's "Harbour"). */
const sameWord = (heard: string, written: string) => heard === written || (heard.length >= 5 && near(heard, written, 1));

/**
 * Put the script's punctuation back on the transcribed words. Whisper's word timings come back bare
 * ("breakdowns", not "breakdowns."), so the sentence-end break above never fired and a caption ran
 * across two sentences ("breakdowns Brightside", the first sample render, 2026-11-01). The script is
 * what was spoken, so each word takes the matching script token's spelling — matched in order, and
 * only when the letters agree or differ by one in a word of 5+ letters (whisper wrote "Harbor" for
 * "Harbour Yoga"), so a word the speaker said differently keeps its own text.
 *
 * A short misheard word is caught by its neighbours instead: one unmatched word between two matched
 * ones, with exactly one script token between theirs, is that token misheard ("Sea views" came back
 * "See views" on the Harbour Yoga sample, 2026-11-02), so it takes the script's spelling. Pure.
 */
export function withScriptPunctuation<W extends { word: string }>(words: W[], script: string | null | undefined): W[] {
    const tokens = String(script ?? '').split(/\s+/).filter(Boolean);
    if (!tokens.length) return words;
    const at: number[] = [];   // the script token each word matched, or -1
    let j = 0;
    for (const w of words) {
        const want = bare(w.word);
        let hit = -1;
        // Look a few tokens ahead: the transcript can drop or merge a word.
        if (want) for (let k = j; k < Math.min(tokens.length, j + 4); k++) {
            if (sameWord(want, bare(tokens[k]))) { hit = k; j = k + 1; break; }
        }
        at.push(hit);
    }
    return words.map((w, i) => {
        if (at[i] >= 0) return { ...w, word: tokens[at[i]] };
        const before = at[i - 1] ?? -1, after = at[i + 1] ?? -1;
        if (bare(w.word) && before >= 0 && after === before + 2) return { ...w, word: tokens[before + 1] };
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

/** Group words into on-screen phrases, as long as the caption mode allows. Pure. */
export function buildCaptionCues(sources: CaptionSource[], mode: CaptionMode = 'highlight'): CaptionCue[] {
    const words = timelineWords(sources);
    const limit = captionLimits(mode);
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
            cur.length >= limit.words
            || chars + 1 + w.text.length > limit.chars
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

/**
 * Caption box geometry for a frame `height` px tall. Shared by the render and any preview. Pure.
 * Exactly one of bottomPct / topPct is set; 'middle' sets topPct to centre the line (with translateY).
 */
export function captionLayout(height: number, style: Pick<CaptionStyle, 'size' | 'position' | 'mode'> = DEFAULT_CAPTION_STYLE): {
    fontSizePx: number; bottomPct?: number; topPct?: number; centre: boolean; sidePct: number; strokePx: number;
} {
    const scale = style.size === 'small' ? 0.046 : style.size === 'large' ? 0.072 : 0.058;
    const fontSizePx = Math.round(height * scale * (style.mode === 'word' ? 1.3 : 1));
    const strokePx = Math.max(2, Math.round(height * 0.004));
    // Bottom sits above the lower ~18 % where Reels/Shorts/TikTok draw their own caption and buttons;
    // top sits below the ~12 % their account name and close button take.
    if (style.position === 'top') return { fontSizePx, topPct: 14, centre: false, sidePct: 7, strokePx };
    if (style.position === 'middle') return { fontSizePx, topPct: 50, centre: true, sidePct: 7, strokePx };
    return { fontSizePx, bottomPct: 21, centre: false, sidePct: 7, strokePx };
}

/** The highlight colour a style asks for: the brand's (when it reads), or its own hex. Pure. */
export function styleAccent(style: CaptionStyle, brandHex: string | null | undefined): string {
    return style.highlight === 'brand' ? captionAccent(brandHex) : style.highlight;
}

/**
 * "Time text to the voice" (post editor): each text box is shown while its words are spoken.
 *
 * A box's words are looked for in the spoken words, in order — the first box from the start, each
 * later box after the one before it (falling back to anywhere, for a box placed out of order). The
 * window that holds the most of the box's words wins; at least half of them must be heard (all of
 * them for a one- or two-word box), else the box keeps its own timing and is reported unmatched.
 * A matched box runs from its first heard word to its last + a short hold, never past the next box's
 * start. Times are on the post's timeline: `offsetS` is where the voiceover starts. Pure.
 */
export function alignTextToWords(
    boxes: Array<{ id: string; text: string }>,
    words: SpokenWordLike[],
    offsetS = 0,
): { timings: Record<string, { startS: number; endS: number }>; unmatched: string[] } {
    const heard = words.map((w) => bare(w.word));
    const timings: Record<string, { startS: number; endS: number }> = {};
    const unmatched: string[] = [];
    let cursor = 0;
    const best = (want: string[], from: number) => {
        let top: { first: number; last: number; hits: number } | null = null;
        const span = want.length + 3;   // room for a few spoken words the box leaves out
        for (let i = from; i < heard.length; i++) {
            if (!want.includes(heard[i])) continue;   // a window starts on a word of the box
            const left = [...want];
            let hits = 0, last = i;
            for (let j = i; j < Math.min(heard.length, i + span); j++) {
                const k = left.indexOf(heard[j]);
                if (k >= 0) { left.splice(k, 1); hits++; last = j; }
            }
            if (!top || hits > top.hits) top = { first: i, last, hits };
            if (hits === want.length) break;
        }
        return top;
    };
    for (const box of boxes) {
        const want = String(box.text || '').split(/\s+/).map(bare).filter(Boolean);
        if (!want.length) { unmatched.push(box.id); continue; }
        const need = want.length <= 2 ? want.length : Math.ceil(want.length / 2);
        let hit = best(want, cursor);
        if (!hit || hit.hits < need) hit = best(want, 0);
        if (!hit || hit.hits < need) { unmatched.push(box.id); continue; }
        timings[box.id] = {
            startS: Math.round((offsetS + words[hit.first].start) * 10) / 10,
            endS: Math.round((offsetS + words[hit.last].end + CAPTION_HOLD_S + 0.4) * 10) / 10,
        };
        cursor = hit.last + 1;
    }
    // Never over the next box: one piece of text at a time reads as the voice moving on.
    const order = Object.entries(timings).sort((a, b) => a[1].startS - b[1].startS);
    for (let i = 0; i < order.length - 1; i++) {
        const next = order[i + 1][1].startS;
        if (order[i][1].endS > next && next > order[i][1].startS) order[i][1].endS = next;
    }
    return { timings, unmatched };
}
