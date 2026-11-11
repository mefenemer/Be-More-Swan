// src/lib/footage.ts
//
// The owner's own footage, understood (docs/video-producer-footage-and-ai-plan.md §4.2–4.3).
//
// Claude takes pictures, not video, so "watching" a video is: frames the BROWSER grabs (no server
// function can open a video file), the sound transcribed with word timings, then one model call that
// turns frames + words into a SHOT LIST. A second call reads the shot lists against what the owner
// wants and returns SUGGESTED EDITS, which the owner ticks; only the ticked ones reach the storyboard.
//
// As with the storyboard, the model WRITES and this module DECIDES: every segment is clamped to the
// MEASURED length, a quote must really be in the transcript, and a suggestion may only point at a
// video the owner chose. PURE: no database, no network. Tested in tests/footage.test.ts.

import { keepsOwnSound, type Scene, type Storyboard, type VideoBrief } from './storyboard';
import { MAX_CLIPS } from './video-edit';

// ── Limits (owner decision D-F5, 2026-11-09) ────────────────────────────────────────────────────
export const MAX_FOOTAGE_S = 5 * 60;
export const MAX_FOOTAGE_BYTES = 500 * 1024 * 1024;
export const MAX_VIDEOS_PER_REVIEW = 10;
/** A frame about every 2 seconds, at most this many — enough to see every shot of a 5-minute video. */
export const MAX_FRAMES = 40;
export const FRAME_EVERY_S = 2;
/** One frame as base64 JPEG — the browser sends ~512 px frames, ~20–40 KB each. */
export const MAX_FRAME_B64 = 220_000;
/** What one review costs by default (owner decision D-F1, 2026-11-09), charged only when a video is newly analysed.
 *  The fallback only: the live figure is footage_review in Admin → Money → Task costs (getTaskCosts). */
export const FOOTAGE_REVIEW_TASKS = 2;
export const MAX_SUGGESTIONS = 12;
export const MAX_SHOTS = 30;

/** When to grab frames for a video of `durationS` seconds. The browser uses the same rule. Pure. */
export function frameTimes(durationS: number): number[] {
    if (!(durationS > 0)) return [];
    const n = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(durationS / FRAME_EVERY_S)));
    const step = durationS / n;
    return Array.from({ length: n }, (_, i) => Math.round(Math.min(durationS - 0.05, step * i + step / 2) * 100) / 100);
}

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────

export interface SpokenWord { word: string; start: number; end: number }

/** One stretch of a video that looks and sounds the same. */
export interface Shot {
    inS: number;
    outS: number;
    /** What you see. */
    what: string;
    /** What is said in it, quoted from the transcript; absent when nothing is. */
    speech?: string;
    /** shaky, dark, out of focus, people talking over each other, dead air … */
    problems: string[];
    /** 0 unusable … 3 one of the strongest moments. */
    strength: 0 | 1 | 2 | 3;
}

export interface ShotList {
    /** One or two sentences: what this video is. */
    summary: string;
    shots: Shot[];
    /** Someone speaks in it. */
    speech: boolean;
    /** Music can be heard (copyright is the owner's — §6). */
    music: boolean;
    /**
     * How loud the sound is every LOUDNESS_STEP_S (RMS × 1000), measured by the browser. Tightening
     * never cuts a loud stretch the transcript can't account for — a transcription that misses words
     * must not cost the owner their own sentence. Absent on analyses made before 2026-11-09.
     */
    loudness?: number[];
}

export const LOUDNESS_STEP_S = 0.1;

export const SUGGESTION_KINDS = ['cut', 'trim', 'reorder', 'fill', 'text', 'sound', 'frame', 'other'] as const;
export type SuggestionKind = typeof SUGGESTION_KINDS[number];

export interface Suggestion {
    id: string;
    kind: SuggestionKind;
    /** The edit, in a sentence ("Cut 0:12–0:19 of kitchen.mp4"). */
    text: string;
    /** Why, in a sentence ("the camera shakes and nothing is said"). */
    reason: string;
    assetId?: number;
    inS?: number;
    outS?: number;
    /** The owner's tick. Suggestions arrive ticked: each is the producer's recommendation. */
    ticked: boolean;
}

export interface SeenVideo { assetId: number; name: string; summary: string; problems: string[] }

export interface FootageReview {
    seen: SeenVideo[];
    suggestions: Suggestion[];
    /** Tasks charged for this review (0 when every video was already analysed). */
    charged: number;
    reviewedAt: string;
}

/** A chosen video as the review and the planner see it. */
export interface FootageVideo { id: number; name: string; durationS: number; analysis: ShotList | null; words: SpokenWord[] }

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const clip = (s: unknown, n: number) => String(typeof s === 'string' ? s : '').replace(URL_RE, '').replace(/\s+/g, ' ').trim().slice(0, n);
const round1 = (n: number) => Math.round(n * 10) / 10;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** 75.4 → "1:15". Pure. */
export function mmss(s: number): string {
    const t = Math.max(0, Math.floor(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** The words spoken between two times, as text. Pure. */
export function wordsBetween(words: SpokenWord[], inS: number, outS: number): string {
    return words.filter((w) => w.start >= inS - 0.05 && w.end <= outS + 0.05).map((w) => w.word).join(' ').replace(/\s+/g, ' ').trim();
}

/** Is `quote` really said (ignoring case and punctuation)? Pure. */
export function quoteIsInTranscript(quote: string, words: SpokenWord[]): boolean {
    const q = norm(quote);
    if (!q) return false;
    return norm(words.map((w) => w.word).join(' ')).includes(q);
}

// ── The shot list ───────────────────────────────────────────────────────────────────────────────

export function shotListSystemPrompt(): string {
    return `You review raw footage for a small business's short social video. You are shown frames from ONE video, each labelled with its time in seconds, and the words spoken in it with their times.

Split the video into shots: stretches that look and sound alike. For each shot give its start and end in seconds, what you see, what is said (quoted EXACTLY from the transcript, or nothing), any problems (shaky, dark, blurry, out of focus, people talking over each other, dead air, someone mid-sentence at a cut, a thumb over the lens …) and how strong it is for a short video: 0 unusable, 1 filler, 2 good, 3 one of the strongest moments.

Never name or guess who a person is. Describe people only by what they are doing. Do not invent anything you cannot see or hear.

Return STRICT JSON only:
{"summary": "one or two sentences: what this video is", "speech": true|false, "music": true|false, "shots": [{"inS": 0, "outS": 4.2, "what": "...", "speech": "...", "problems": ["..."], "strength": 0|1|2|3}]}`;
}

/** The words, compactly, for the shot-list call: "[12.3] hello there [13.1] and welcome". Pure. */
export function transcriptText(words: SpokenWord[], maxChars = 6000): string {
    if (!words.length) return '(no speech)';
    const out: string[] = [];
    let last = -10;
    for (const w of words) {
        if (w.start - last >= 2) { out.push(`[${w.start.toFixed(1)}]`); last = w.start; }
        out.push(w.word);
    }
    return out.join(' ').slice(0, maxChars);
}

/**
 * Make a model's shot list safe to trust. Pure; never throws. Segments are clamped to the measured
 * length and put in order; a quote that isn't in the transcript is replaced by the words really heard
 * in that stretch (the model paraphrases), and a shot with nothing left is dropped.
 */
export function enforceShotList(raw: unknown, durationS: number, words: SpokenWord[]): ShotList {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const shots: Shot[] = [];
    for (const item of (Array.isArray(r.shots) ? r.shots : []).slice(0, MAX_SHOTS * 2)) {
        const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        let a = Number(o.inS), b = Number(o.outS);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        if (b < a) [a, b] = [b, a];
        a = Math.max(0, Math.min(durationS, a));
        b = Math.max(0, Math.min(durationS, b));
        if (b - a < 0.3) continue;
        const heard = wordsBetween(words, a, b);
        let speech = clip(o.speech, 300);
        if (speech && !quoteIsInTranscript(speech, words)) speech = clip(heard, 300);
        const strength = Math.max(0, Math.min(3, Math.round(Number(o.strength) || 0))) as Shot['strength'];
        const shot: Shot = {
            inS: round1(a), outS: round1(b), what: clip(o.what, 200) || 'A shot',
            problems: (Array.isArray(o.problems) ? o.problems : []).map((p) => clip(p, 80)).filter(Boolean).slice(0, 5),
            strength,
        };
        if (speech) shot.speech = speech;
        shots.push(shot);
    }
    shots.sort((x, y) => x.inS - y.inS);
    // Overlaps: a later shot starts where the earlier one ended.
    for (let i = 1; i < shots.length; i++) if (shots[i].inS < shots[i - 1].outS) shots[i].inS = shots[i - 1].outS;
    const kept = shots.filter((s) => s.outS - s.inS >= 0.3).slice(0, MAX_SHOTS);
    return {
        summary: clip(r.summary, 300) || 'A video.',
        shots: kept.length ? kept : [{ inS: 0, outS: round1(durationS), what: 'The whole video', problems: [], strength: 1 }],
        speech: words.length > 0,
        music: r.music === true,
    };
}

// ── The review: suggested edits ─────────────────────────────────────────────────────────────────

export function reviewSystemPrompt(): string {
    return `You are a short-form video editor for a small business. The owner has given you their own footage and said what video they want. You have a shot list for each video (times in seconds, what is seen and said, problems, strength).

Say briefly what you saw in each video, then suggest the edits that would make the video they asked for. Each suggestion is ONE concrete edit with a one-line reason:
- cut: leave out a stretch ("Cut 0:12–0:19 of kitchen.mp4")
- trim: shorten a shot's start or end
- reorder: change what comes first ("Open on the latte art")
- fill: a gap their footage can't fill — a branded card, stock footage or an AI clip ("Add a branded card with the booking link at the end")
- text: words on screen, or captions
- sound: keep their sound, or put a voiceover over it
Point at a video by its id and at a stretch by inS/outS in seconds ONLY when the edit is about that stretch (a cut, a trim, a moment to move). Use only stretches from the shot lists. Write times as minutes:seconds, e.g. 0:08 or 1:15 — never 8:00 for eight seconds. Never name or guess who a person is. At most ${MAX_SUGGESTIONS} suggestions, the most important first.

Suggest ONLY what this video maker can do: cut, trim and reorder their footage; fill a gap with stock footage, a stock photo, a branded card (their logo, a headline and their website) or an AI clip or picture; short words on screen; captions; keep their sound or put a voiceover over it. It can NOT add background music, animations, lower-thirds, transitions, effects, colour grading, logos over footage, or crop and reframe a clip — never suggest those. Scenes play one AFTER another: stock or a card can go between sentences, never over someone speaking, so never suggest cutaways while someone talks. Do not suggest what happens anyway: every video is made vertical (9:16) and the call to action goes at the end.

Return STRICT JSON only:
{"seen": [{"assetId": 1, "summary": "...", "problems": ["..."]}], "suggestions": [{"kind": "cut|trim|reorder|fill|text|sound|frame|other", "text": "...", "reason": "...", "assetId": 1, "inS": 0, "outS": 3}]}`;
}

/** A video's shot list, for a prompt. Pure. */
export function shotListText(v: FootageVideo): string {
    const a = v.analysis;
    if (!a) return `VIDEO id ${v.id} "${clip(v.name, 80)}" (${v.durationS.toFixed(1)} s): not analysed.`;
    const shots = a.shots.map((s) => `  ${s.inS.toFixed(1)}–${s.outS.toFixed(1)} s · strength ${s.strength} · ${s.what}${s.speech ? ` · says "${s.speech}"` : ''}${s.problems.length ? ` · problems: ${s.problems.join(', ')}` : ''}`);
    return [`VIDEO id ${v.id} "${clip(v.name, 80)}" (${v.durationS.toFixed(1)} s${a.music ? ', music can be heard' : ''}${a.speech ? '' : ', no speech'}): ${a.summary}`, ...shots].join('\n');
}

export function reviewUserPrompt(args: { brief: VideoBrief; businessName: string; videos: FootageVideo[] }): string {
    const b = args.brief;
    return [
        `BUSINESS: ${clip(args.businessName, 120)}`,
        `THE VIDEO THEY WANT: a ${b.lengthS}-second vertical ${clip(b.purpose, 60) || 'promo'} video. ${clip(b.message, 800)}`,
        b.cta ? `CALL TO ACTION: ${clip(b.cta, 200)}` : '',
        b.voiceover ? 'It will have a voiceover over the footage (their footage\'s own sound is turned down).' : 'No voiceover: the video keeps the footage\'s own sound.',
        `THEIR FOOTAGE:\n${args.videos.map(shotListText).join('\n\n')}`,
    ].filter(Boolean).join('\n\n');
}

/** Make a model's review safe to show. Pure; never throws. */
export function enforceReview(raw: unknown, videos: FootageVideo[], charged: number, now = new Date()): FootageReview {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const byId = new Map(videos.map((v) => [v.id, v]));
    const seenRaw = new Map<number, Record<string, unknown>>();
    for (const item of Array.isArray(r.seen) ? r.seen : []) {
        const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        if (byId.has(Number(o.assetId))) seenRaw.set(Number(o.assetId), o);
    }
    // Every chosen video gets a line, in the owner's order — the model's, or its own shot-list summary.
    const seen: SeenVideo[] = videos.map((v) => {
        const o = seenRaw.get(v.id);
        const problems = (o && Array.isArray(o.problems) ? o.problems : []).map((p) => clip(p, 120)).filter(Boolean).slice(0, 5);
        return { assetId: v.id, name: clip(v.name, 80), summary: clip(o?.summary, 300) || v.analysis?.summary || '', problems };
    });
    const suggestions: Suggestion[] = [];
    for (const item of Array.isArray(r.suggestions) ? r.suggestions : []) {
        if (suggestions.length >= MAX_SUGGESTIONS) break;
        const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const text = clip(o.text, 200);
        if (!text) continue;
        const kind: SuggestionKind = (SUGGESTION_KINDS as readonly string[]).includes(String(o.kind)) ? o.kind as SuggestionKind : 'other';
        const s: Suggestion = { id: `e${suggestions.length + 1}`, kind, text, reason: clip(o.reason, 200), ticked: true };
        const v = byId.get(Number(o.assetId));
        if (v) {
            s.assetId = v.id;
            const a = Number(o.inS), b = Number(o.outS);
            // A stretch only where the edit is ABOUT one; "add a card" pointing at the whole video
            // printed "(0:00–0:08)" on every suggestion (staging, 2026-11-09).
            const aboutStretch = kind === 'cut' || kind === 'trim' || kind === 'reorder';
            if (aboutStretch && Number.isFinite(a) && Number.isFinite(b) && b > a) {
                s.inS = round1(Math.max(0, Math.min(v.durationS, a)));
                s.outS = round1(Math.max(0, Math.min(v.durationS, b)));
                if (s.outS - s.inS < 0.3) { delete s.inS; delete s.outS; }
            }
        }
        suggestions.push(s);
    }
    return { seen, suggestions, charged, reviewedAt: now.toISOString() };
}

/** A suggestion as one line for the planner ("… (video 12, 3.0–7.5 s) — because …"). Pure. */
export function suggestionLine(s: Suggestion): string {
    const where = s.assetId ? ` (video ${s.assetId}${s.inS != null && s.outS != null ? `, ${s.inS.toFixed(1)}–${s.outS.toFixed(1)} s` : ''})` : '';
    return `${s.text}${where}${s.reason ? ` — ${s.reason}` : ''}`;
}

/** The owner's footage for the storyboard planner: each video's id, length and shot list. Pure. */
export function footagePlannerBlock(videos: FootageVideo[]): string {
    if (!videos.length) return '';
    return `THE OWNER'S OWN FOOTAGE (use as own_video scenes with this assetId; inS/outS in seconds within the length):\n${videos.map(shotListText).join('\n\n')}`;
}

// ── Tightening: pauses, filler words and repeated takes out ─────────────────────────────────────
//
// The owner's footage in its own sound is usually someone talking: pauses, "um"s, and a sentence
// started twice. The review already has every word with its time (whisper), so tightening is RULES,
// not a model call — free, instant, and the same every time. A segment becomes a list of PIECES of
// the same file; only the pieces play. Words are never moved or invented, only left out.

export interface Piece { inS: number; outS: number }
export interface TightenStats { pauses: number; fillers: number; retakes: number; savedS: number }

/** A pause longer than this is cut down to the padding either side of it. */
export const MAX_PAUSE_S = 0.5;
/** Kept before a word starts and after it ends, so speech isn't clipped. */
export const PAD_BEFORE_S = 0.12;
export const PAD_AFTER_S = 0.18;
/** A piece shorter than this is merged into its neighbour — a flash is worse than a pause. */
export const MIN_PIECE_S = 0.4;
/**
 * Hesitations only. Never "like", "so", "you know" — those are real words often enough that cutting
 * them changes what someone said.
 */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'eh', 'hmm', 'mm', 'mhm']);
const wnorm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

/** Is this word a hesitation ("um", "uh…")? Pure. */
export function isFiller(word: string): boolean {
    return FILLERS.has(wnorm(word));
}

/**
 * Indexes of words in a false start: a run of 3+ words said again within the next few words ("we
 * opened in, we opened in March") — the FIRST attempt and anything between are dropped, the last take
 * is kept. Longest match first. Pure.
 */
export function retakeIndexes(words: SpokenWord[]): { drop: Set<number>; retakes: number } {
    const n = words.map((w) => wnorm(w.word));
    const drop = new Set<number>();
    let retakes = 0;
    for (let i = 0; i < n.length; i++) {
        if (drop.has(i) || !n[i]) continue;
        let found = false;
        for (let len = Math.min(8, Math.floor((n.length - i) / 2)); len >= 3 && !found; len--) {
            // The repeat starts right after the first attempt, or after up to 3 words of stumbling.
            for (let gap = 0; gap <= 3 && !found; gap++) {
                const j = i + len + gap;
                if (j + len > n.length) break;
                let same = true;
                for (let k = 0; k < len; k++) if (n[i + k] !== n[j + k] || !n[i + k]) { same = false; break; }
                if (same) {
                    for (let k = i; k < j; k++) drop.add(k);
                    retakes++;
                    found = true;
                }
            }
        }
    }
    return { drop, retakes };
}

/**
 * One segment of the owner's video → the pieces that play. Silent footage (no words in it) plays as
 * it is: a shot of the shop with no one speaking has no pauses to cut. Pure.
 */
export function tightenSegment(inS: number, outS: number, words: SpokenWord[], loudness?: number[]): { pieces: Piece[]; stats: TightenStats } {
    const whole = { pieces: [{ inS, outS }], stats: { pauses: 0, fillers: 0, retakes: 0, savedS: 0 } };
    const inside = words.filter((w) => w.start >= inS - 0.02 && w.end <= outS + 0.02 && w.end > w.start);
    if (!inside.length) return whole;
    const { drop, retakes } = retakeIndexes(inside);
    let fillers = 0;
    const kept = inside.filter((w, i) => {
        if (drop.has(i)) return false;
        if (isFiller(w.word)) { fillers++; return false; }
        return true;
    });
    if (!kept.length) return whole;   // nothing but "um"s: leave it to the owner, never an empty scene
    // Runs of kept words; a run breaks at a long pause or where words were left out.
    const keptIdx = new Set(kept.map((w) => inside.indexOf(w)));
    const runs: Array<{ from: SpokenWord; to: SpokenWord }> = [];
    let pauses = 0;
    let prevIdx = -2;
    for (let i = 0; i < inside.length; i++) {
        if (!keptIdx.has(i)) continue;
        const w = inside[i];
        const last = runs[runs.length - 1];
        const contiguous = prevIdx === i - 1;
        if (last && contiguous && w.start - last.to.end <= MAX_PAUSE_S) last.to = w;
        else {
            if (last && contiguous) pauses++;
            runs.push({ from: w, to: w });
        }
        prevIdx = i;
    }
    let pieces: Piece[] = runs.map((r) => ({
        inS: Math.max(inS, r.from.start - PAD_BEFORE_S),
        outS: Math.min(outS, r.to.end + PAD_AFTER_S),
    }));
    // Padding can make neighbours touch: join them. Then fold flashes into a neighbour.
    pieces = joinPieces(pieces, 0.05);
    // The safety net: a stretch about to be cut that is LOUD for longer than the words left out of it
    // can explain is speech the transcript missed, and stays (staging, 2026-11-09: a missed opening
    // sentence was cut as a 5.8 s "pause").
    if (loudness?.length) {
        const dropped = inside.filter((w) => !keptIdx.has(inside.indexOf(w)));
        pieces = restoreLoudGaps(pieces, inS, outS, loudness, kept, dropped);
        pauses = Math.min(pauses, Math.max(0, pieces.length - 1));
    }
    pieces = foldShortPieces(pieces);
    const kept2 = pieces.reduce((a, p) => a + (p.outS - p.inS), 0);
    const savedS = Math.max(0, (outS - inS) - kept2);
    if (savedS < 0.3) return whole;   // nothing worth a cut
    return { pieces: pieces.map((p) => ({ inS: round2(p.inS), outS: round2(p.outS) })), stats: { pauses, fillers, retakes, savedS: round1(savedS) } };
}

/** Seconds of [a, b) that are louder than `level`. Pure. */
export function loudSeconds(loudness: number[], a: number, b: number, level: number): number {
    let n = 0;
    for (let i = Math.max(0, Math.floor(a / LOUDNESS_STEP_S)); i < Math.min(loudness.length, Math.ceil(b / LOUDNESS_STEP_S)); i++) {
        if (loudness[i] > level) n++;
    }
    return n * LOUDNESS_STEP_S;
}

/**
 * Put back every cut gap (between pieces, and before the first / after the last) that is loud for
 * longer than the dropped words inside it explain. "Loud" = over 40% of the typical loudness of the
 * words that were kept. Pure.
 */
export function restoreLoudGaps(pieces: Piece[], inS: number, outS: number, loudness: number[], kept: SpokenWord[], dropped: SpokenWord[]): Piece[] {
    const levels: number[] = [];
    for (const w of kept) {
        for (let i = Math.floor(w.start / LOUDNESS_STEP_S); i < Math.ceil(w.end / LOUDNESS_STEP_S) && i < loudness.length; i++) levels.push(loudness[i]);
    }
    if (!levels.length) return pieces;
    levels.sort((x, y) => x - y);
    const level = levels[Math.floor(levels.length / 2)] * 0.4;
    const unexplained = (a: number, b: number) => {
        const said = dropped.filter((w) => w.start >= a - 0.05 && w.end <= b + 0.05).reduce((t, w) => t + (w.end - w.start), 0);
        return loudSeconds(loudness, a, b, level) > said + 0.5;
    };
    const out = pieces.map((p) => ({ ...p }));
    if (out.length && unexplained(inS, out[0].inS)) out[0].inS = inS;
    if (out.length && unexplained(out[out.length - 1].outS, outS)) out[out.length - 1].outS = outS;
    const merged: Piece[] = [];
    for (const p of out) {
        const last = merged[merged.length - 1];
        if (last && unexplained(last.outS, p.inS)) last.outS = p.outS;
        else merged.push(p);
    }
    return merged;
}

function joinPieces(pieces: Piece[], within: number): Piece[] {
    const out: Piece[] = [];
    for (const p of pieces) {
        const last = out[out.length - 1];
        if (last && p.inS - last.outS <= within) last.outS = Math.max(last.outS, p.outS);
        else out.push({ ...p });
    }
    return out;
}

function foldShortPieces(pieces: Piece[]): Piece[] {
    let out = pieces.map((p) => ({ ...p }));
    for (let guard = 0; guard < 50; guard++) {
        const i = out.findIndex((p) => p.outS - p.inS < MIN_PIECE_S);
        if (i < 0 || out.length === 1) break;
        // Merge into whichever neighbour is nearer in the source.
        const left = i > 0 ? out[i].inS - out[i - 1].outS : Infinity;
        const right = i < out.length - 1 ? out[i + 1].inS - out[i].outS : Infinity;
        if (left <= right) { out[i - 1].outS = out[i].outS; out.splice(i, 1); }
        else { out[i + 1].inS = out[i].inS; out.splice(i, 1); }
    }
    out = joinPieces(out, 0.05);
    return out;
}

/**
 * Keep the whole video inside the render's clip limit: while there are too many pieces, rejoin the
 * pair with the SHORTEST gap between them (the least worth cutting), across every scene. `fixedCount`
 * is the clips from scenes that aren't tightened. Mutates nothing; returns new lists. Pure.
 */
export function capPieces(lists: Piece[][], maxTotal: number, fixedCount = 0): Piece[][] {
    const out = lists.map((l) => l.map((p) => ({ ...p })));
    const count = () => out.reduce((a, l) => a + l.length, 0) + fixedCount;
    while (count() > maxTotal) {
        let best: { li: number; i: number; gap: number } | null = null;
        out.forEach((l, li) => {
            for (let i = 0; i + 1 < l.length; i++) {
                const gap = l[i + 1].inS - l[i].outS;
                if (!best || gap < best.gap) best = { li, i, gap };
            }
        });
        if (!best) break;
        const { li, i } = best as { li: number; i: number };
        out[li][i].outS = out[li][i + 1].outS;
        out[li].splice(i + 1, 1);
    }
    return out;
}

/**
 * Tighten every own-video scene of a storyboard from the review's word timings. Only footage in its
 * own sound — under a voiceover the clips are silent and the voice sets the cut. A scene the owner
 * set to "Keep as filmed" (tighten: false), or a brief with tightening off, plays its whole segment.
 * Each tightened scene's length becomes the length of its pieces; the whole video stays inside the
 * render's clip limit. Returns a new storyboard and what changed. Pure.
 */
export function tightenStoryboard(sb: Storyboard, brief: VideoBrief, videos: FootageVideo[]): { storyboard: Storyboard; changes: string[] } {
    const byId = new Map(videos.map((v) => [v.id, v]));
    const scenes = sb.scenes.map((s) => {
        const c: Scene = { ...s };
        delete c.cuts; delete c.tightened;
        if (c.source === 'own_video' && c.inS != null && c.outS != null && keepsOwnSound(brief)) {
            // In its own sound a scene never starts or ends mid-sentence, tightened or not.
            const v = c.assetId ? byId.get(c.assetId) : undefined;
            if (v && v.durationS > 0) ({ inS: c.inS, outS: c.outS } = snapSegment(c.inS, c.outS, v.words, v.durationS, v.analysis?.loudness));
            c.targetS = round1(c.outS - c.inS);
        }
        return c;
    });
    const on = keepsOwnSound(brief) && brief.tighten !== false;
    if (!on) return { storyboard: { ...sb, scenes }, changes: [] };
    const words = new Map(videos.map((v) => [v.id, v.words]));
    const tight: Array<{ i: number; pieces: Piece[]; stats: TightenStats; segS: number }> = [];
    scenes.forEach((s, i) => {
        if (s.source !== 'own_video' || s.tighten === false || s.inS == null || s.outS == null || !s.assetId) return;
        const v = videos.find((x) => x.id === s.assetId);
        const { pieces, stats } = tightenSegment(s.inS, s.outS, words.get(s.assetId) ?? [], v?.analysis?.loudness);
        if (stats.savedS > 0) tight.push({ i, pieces, stats, segS: s.outS - s.inS });
    });
    if (!tight.length) return { storyboard: { ...sb, scenes }, changes: [] };
    // Every scene that isn't tightened is one clip (a still too); the rest share the limit.
    const fixedCount = scenes.length - tight.length;
    const capped = capPieces(tight.map((t) => t.pieces), MAX_CLIPS, fixedCount);
    let saved = 0;
    tight.forEach((t, k) => {
        const pieces = capped[k];
        const len = pieces.reduce((a, p) => a + (p.outS - p.inS), 0);
        const s = scenes[t.i];
        s.cuts = pieces;
        s.targetS = round1(len);
        s.tightened = { ...t.stats, savedS: round1(Math.max(0, t.segS - len)) };
        saved += t.segS - len;
    });
    const total = scenes.reduce((a, s) => a + s.targetS, 0);
    return {
        storyboard: { ...sb, scenes },
        changes: saved >= 0.5 ? [`Pauses, “um”s and repeated takes cut from your clips: ${saved.toFixed(1)} s shorter, about ${Math.round(total)} s in all.`] : [],
    };
}

/**
 * Move a segment's ends out of the middle of speech: an end that falls inside a word, or just before
 * more words follow, runs on to the next pause (or the end of the file); a start does the same going
 * back. Then, with loudness, an end that is still loud runs on while it stays loud (up to 3 s), for
 * words the transcript missed. The planner cut a speaker off at 0:25 of 0:29 (staging, 2026-11-09). Pure.
 */
export function snapSegment(inS: number, outS: number, words: SpokenWord[], durationS: number, loudness?: number[]): { inS: number; outS: number } {
    const ws = words.filter((w) => w.end > w.start).slice().sort((a, b) => a.start - b.start);
    let a = inS, b = outS;
    // Is time t mid-speech? Inside a word, or inside a gap between two words shorter than a pause.
    const midSpeech = (t: number): number => {
        const k = ws.findIndex((w) => w.end > t);       // the first word not over by t
        if (k < 0) return -1;
        if (ws[k].start <= t) return k;                  // inside a word
        if (k > 0 && ws[k].start - ws[k - 1].end < MAX_PAUSE_S) return k;   // a breath, not a pause
        return -1;
    };
    // End: run on through the sentence it falls in.
    const i = midSpeech(b);
    if (i >= 0) {
        let end = ws[i].end;
        for (let k = i + 1; k < ws.length && ws[k].start - end < MAX_PAUSE_S; k++) end = ws[k].end;
        b = Math.max(b, end + PAD_AFTER_S);
    }
    // Start: back to the beginning of the sentence it falls in.
    const j = midSpeech(a);
    if (j >= 0) {
        let start = ws[j].start;
        for (let k = j - 1; k >= 0 && start - ws[k].end < MAX_PAUSE_S; k--) start = ws[k].start;
        a = Math.min(a, start - PAD_BEFORE_S);
    }
    if (loudness?.length) {
        const levels = ws.flatMap((w) => {
            const out: number[] = [];
            for (let t = Math.floor(w.start / LOUDNESS_STEP_S); t < Math.ceil(w.end / LOUDNESS_STEP_S) && t < loudness.length; t++) out.push(loudness[t]);
            return out;
        }).sort((x, y) => x - y);
        const level = levels.length ? levels[Math.floor(levels.length / 2)] * 0.4 : Infinity;
        const limit = Math.min(durationS, b + 3);
        while (b < limit && loudSeconds(loudness, b, b + 0.3, level) >= 0.2) b += 0.1;
    }
    return { inS: round2(Math.max(0, a)), outS: round2(Math.min(durationS, b)) };
}

/** "2 pauses, 1 “um”, 1 repeated take — 3.1 s shorter". Pure. */
export function describeTightening(st: TightenStats): string {
    const parts = [
        st.pauses ? `${st.pauses} pause${st.pauses === 1 ? '' : 's'}` : '',
        st.fillers ? `${st.fillers} “um”${st.fillers === 1 ? '' : 's'}` : '',
        st.retakes ? `${st.retakes} repeated take${st.retakes === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return `${parts.length ? parts.join(', ') : 'Dead air'} cut — ${st.savedS.toFixed(1)} s shorter`;
}

// ── Captions for footage in its own sound ───────────────────────────────────────────────────────

/**
 * The words people say in the owner's clips, moved onto the finished video's timeline, so a video in
 * its own sound gets captions that follow the speech (Format Finder's "captions synced"). A word is
 * kept only when it is wholly inside the part of the segment that plays. Pure.
 */
export function ownSpeechOnTimeline(
    scenes: Scene[], durations: number[], wordsByAsset: Map<number, SpokenWord[]>,
): SpokenWord[] {
    const out: SpokenWord[] = [];
    let t = 0;
    scenes.forEach((s, i) => {
        const d = durations[i] ?? s.targetS;
        if (s.source === 'own_video' && s.assetId && s.inS != null) {
            // A tightened scene plays only its pieces, back to back; a word is shown where it plays.
            const pieces: Piece[] = s.cuts?.length ? s.cuts : [{ inS: s.inS, outS: s.inS + d }];
            let at = t;
            for (const p of pieces) {
                for (const w of wordsByAsset.get(s.assetId) ?? []) {
                    if (w.start >= p.inS - 0.02 && w.end <= p.outS + 0.02) {
                        out.push({ word: w.word, start: round2(at + w.start - p.inS), end: round2(at + Math.min(w.end, p.outS) - p.inS) });
                    }
                }
                at += p.outS - p.inS;
            }
        }
        t += d;
    });
    return out;
}
const round2 = (n: number) => Math.round(Math.max(0, n) * 100) / 100;

/**
 * A silent WAV — the audio a caption-only track plays (at volume 0) so the render, which reads
 * caption words from a voiceover asset, can caption footage in its own sound. 8 kHz mono 8-bit. Pure.
 */
export function silentWav(seconds = 1): Buffer {
    const rate = 8000;
    const n = Math.max(1, Math.round(rate * seconds));
    const buf = Buffer.alloc(44 + n);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
    buf.write('data', 36); buf.writeUInt32LE(n, 40);
    buf.fill(128, 44);   // 8-bit PCM silence is the midpoint
    return buf;
}

/** Parse the model's JSON reply. Pure; null when there is none. */
export function parseJsonObject(text: string): unknown | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
