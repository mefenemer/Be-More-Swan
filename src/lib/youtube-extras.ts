// src/lib/youtube-extras.ts
//
// What a Video Producer video gets on YouTube beyond the upload itself (2026-11-11):
//
//   · A thumbnail — the post's own picture, else the video's first still scene (branded card, photo,
//     AI picture). Uses the upload permission we already have. YouTube only allows custom thumbnails
//     on a channel that has verified its phone number, so a refusal is noted, never a failure.
//   · Caption files — the spoken words as an SRT track in English, plus every translation made on the
//     Videos tab. Needs `youtube.force-ssl`, a permission we only ask for once the switch is on.
//   · Results — views, likes and comments per video (`youtube.readonly`, which we have), and the
//     drop-off curve and average watched (`yt-analytics.readonly`, behind the same switch).
//
// The two new permissions need Google's review and a reconnect, so they sit behind the feature flag
// 'youtube_extended_scopes' (Admin → Feature flags), off until Google approves them. A connection
// that hasn't granted a permission simply skips that part.
//
// PURE. Tested in tests/youtube-extras.test.ts.

export const YT_SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
export const YT_SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
/** Caption tracks (captions.insert). Sensitive: Google review. */
export const YT_SCOPE_CAPTIONS = 'https://www.googleapis.com/auth/youtube.force-ssl';
/** YouTube Analytics reports (the drop-off curve, average watched). Sensitive: Google review. */
export const YT_SCOPE_ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
export const YT_EXTENDED_SCOPES_FLAG = 'youtube_extended_scopes';

/** The scopes the YouTube consent screen asks for: the two we have, plus the two new ones when the switch is on. */
export function youtubeScopes(extended: boolean): string {
    return [YT_SCOPE_UPLOAD, YT_SCOPE_READONLY, ...(extended ? [YT_SCOPE_CAPTIONS, YT_SCOPE_ANALYTICS] : [])].join(' ');
}

/** Did this connection grant `scope`? Google reports granted scopes space-separated; we store them as given. Pure. */
export function hasScope(granted: string | null | undefined, scope: string): boolean {
    return String(granted ?? '').split(/[\s,]+/).includes(scope);
}

// ── Caption files ─────────────────────────────────────────────────────────────────────────────────

/** One line of a caption file: seconds on the finished video, and its words. */
export interface CaptionLine { s: number; e: number; t: string }

/** Longer lines than the burned-in captions: a caption file is read under the picture, not over it. */
export const FILE_LINE_MAX_CHARS = 42;
export const FILE_LINE_MAX_S = 6;
const PAUSE_S = 0.6;

/** Timed words → caption file lines: break at sentence ends, pauses, ~42 characters or 6 seconds. Pure. */
export function captionLines(words: Array<{ word: string; startS: number; endS: number }>): CaptionLine[] {
    const out: CaptionLine[] = [];
    let cur: typeof words = [];
    const flush = () => {
        if (!cur.length) return;
        out.push({ s: r3(cur[0].startS), e: r3(cur[cur.length - 1].endS), t: cur.map((w) => w.word).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim() });
        cur = [];
    };
    for (const w of words) {
        const word = String(w.word ?? '').trim();
        if (!word || !Number.isFinite(w.startS) || !Number.isFinite(w.endS)) continue;
        const prev = cur[cur.length - 1];
        const len = cur.reduce((n, x) => n + x.word.length + 1, 0) + word.length;
        if (prev && (w.startS - prev.endS >= PAUSE_S || len > FILE_LINE_MAX_CHARS || w.endS - cur[0].startS > FILE_LINE_MAX_S)) flush();
        cur.push({ word, startS: w.startS, endS: Math.max(w.endS, w.startS) });
        if (/[.!?]$/.test(word)) flush();
    }
    flush();
    return out;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function stamp(s: number, sep: ',' | '.'): string {
    const ms = Math.max(0, Math.round(s * 1000));
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), sec = Math.floor((ms % 60_000) / 1000), milli = ms % 1000;
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(sec)}${sep}${p(milli, 3)}`;
}

/** Clean one line's text for a file: no line breaks, no arrows a parser could misread. Pure. */
function fileText(t: string): string {
    return String(t ?? '').replace(/\r?\n+/g, ' ').replace(/-->/g, '→').trim();
}

/** SubRip (.srt) — what YouTube's caption upload takes. Pure. */
export function toSrt(lines: CaptionLine[]): string {
    return lines.filter((l) => fileText(l.t)).map((l, i) => `${i + 1}\n${stamp(l.s, ',')} --> ${stamp(Math.max(l.e, l.s + 0.2), ',')}\n${fileText(l.t)}\n`).join('\n');
}

/** WebVTT (.vtt) — what web players and most editors take. Pure. */
export function toVtt(lines: CaptionLine[]): string {
    return `WEBVTT\n\n${lines.filter((l) => fileText(l.t)).map((l) => `${stamp(l.s, '.')} --> ${stamp(Math.max(l.e, l.s + 0.2), '.')}\n${fileText(l.t)}\n`).join('\n')}`;
}

/** Read stored lines back, dropping anything malformed. Pure. */
export function readCaptionLines(raw: unknown): CaptionLine[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        const s = Number(o.s), e = Number(o.e), t = typeof o.t === 'string' ? o.t.trim() : '';
        return Number.isFinite(s) && Number.isFinite(e) && t ? [{ s, e: Math.max(e, s), t: t.slice(0, 300) }] : [];
    }).slice(0, 2000);
}

// ── Translation languages ─────────────────────────────────────────────────────────────────────────

/** The languages captions can be translated into: BCP-47 code (what YouTube's caption track takes) → name. */
export const CAPTION_LANGUAGES: Record<string, string> = {
    cy: 'Welsh', ga: 'Irish', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese',
    nl: 'Dutch', pl: 'Polish', ro: 'Romanian', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish',
    el: 'Greek', tr: 'Turkish', ar: 'Arabic', ur: 'Urdu', hi: 'Hindi', pa: 'Punjabi', bn: 'Bengali',
    'zh-Hans': 'Chinese (Simplified)', ja: 'Japanese', ko: 'Korean', uk: 'Ukrainian',
};
export const MAX_TRANSLATIONS = 10;

export function isCaptionLanguage(code: unknown): code is string {
    return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CAPTION_LANGUAGES, code);
}

/**
 * The model's translation, line for line, back onto the English timings. Refuses anything that doesn't
 * line up (a different number of lines, an empty line) rather than guess which line moved. Pure.
 */
export function mergeTranslation(english: CaptionLine[], translated: unknown): CaptionLine[] | { error: string } {
    const list = Array.isArray(translated) ? translated : null;
    if (!list || list.length !== english.length) return { error: 'The translation didn’t match the captions line for line. Try again.' };
    const out: CaptionLine[] = [];
    for (let i = 0; i < english.length; i++) {
        const t = typeof list[i] === 'string' ? fileText(list[i] as string).slice(0, 300) : '';
        if (!t) return { error: 'The translation left a line empty. Try again.' };
        out.push({ s: english[i].s, e: english[i].e, t });
    }
    return out;
}

// ── Results on YouTube ────────────────────────────────────────────────────────────────────────────

export interface YouTubeStats { views: number; likes: number | null; comments: number | null }
/** One point of the drop-off curve: how far into the video (0..1), and the share still watching (0..~1.2). */
export interface RetentionPoint { at: number; watching: number }

/** videos.list?part=statistics → numbers (likes and comments are null when the channel hides them). Pure. */
export function readStats(item: unknown): YouTubeStats | null {
    const s = (item && typeof item === 'object' ? (item as { statistics?: Record<string, unknown> }).statistics : null) ?? null;
    if (!s) return null;
    const n = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    return { views: n(s.viewCount) ?? 0, likes: n(s.likeCount), comments: n(s.commentCount) };
}

/** A YouTube Analytics report (dimensions elapsedVideoTimeRatio, metric audienceWatchRatio) → points. Pure. */
export function readRetention(report: unknown): RetentionPoint[] {
    const rows = (report && typeof report === 'object' ? (report as { rows?: unknown }).rows : null);
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r) => {
        if (!Array.isArray(r) || r.length < 2) return [];
        const at = Number(r[0]), watching = Number(r[1]);
        return Number.isFinite(at) && Number.isFinite(watching) ? [{ at: Math.max(0, Math.min(1, at)), watching: Math.max(0, watching) }] : [];
    }).sort((a, b) => a.at - b.at);
}

/**
 * Where viewers leave: the steepest fall in the curve over any ~5% of the video, as seconds in, and how
 * many of those watching left there. Null when the curve is too short to say. Pure.
 */
export function biggestDrop(points: RetentionPoint[], durationS: number): { atS: number; lostPct: number } | null {
    if (points.length < 5 || !(durationS > 0)) return null;
    let best: { atS: number; lostPct: number } | null = null;
    for (let i = 0; i < points.length; i++) {
        const j = points.findIndex((p) => p.at >= points[i].at + 0.05);
        if (j === -1) break;
        const from = points[i].watching, to = points[j].watching;
        if (from <= 0) continue;
        const lost = (from - to) / from;
        if (!best || lost > best.lostPct) best = { atS: Math.round(points[i].at * durationS * 10) / 10, lostPct: lost };
    }
    return best && best.lostPct > 0.05 ? { atS: best.atS, lostPct: Math.round(best.lostPct * 100) } : null;
}

/** The share of viewers still watching at the end (the last point), as a whole percent, or null. Pure. */
export function watchedToEndPct(points: RetentionPoint[]): number | null {
    const last = points[points.length - 1];
    return last ? Math.round(Math.min(1, last.watching) * 100) : null;
}
