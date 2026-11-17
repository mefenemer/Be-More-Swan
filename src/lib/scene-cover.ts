// src/lib/scene-cover.ts
//
// Scene layouts for walkthrough videos (docs/video-producer-screen-walkthrough-plan.md §3, Phases 1–2;
// decisions D-W4 taken 2026-11-17). The presenter's sound always runs underneath; each scene chooses what
// you SEE:
//
//   (no cover)  Presenter          — the presenter full frame, as every own-video scene before this
//   'bubble'    Screen + bubble    — the screen full frame, the presenter in a round bubble in a corner
//   'cover'     Screen only        — the screen (or a stock clip / picture) full frame; the presenter heard, not seen
//   'window'    Presenter + window — the presenter full frame, the screen in a small rounded window in a corner
//
// A cover is timed in OUTPUT seconds (coverWindow), like text and audio, not per clip: a tightened scene is
// many pieces of the presenter's file, and the screen must play straight through them. The presenter's
// clips are then split where a cover starts or ends (applyCovers), so each piece has one layout.
//
// Shared by the build (src/utils/video-producer.ts), the render worker and the Remotion composition
// (remotion/PostOverlay.tsx) — so it stays PURE: no database, no DOM. Tested in tests/scene-cover.test.ts.

import type { VideoClip } from './video-edit';

export const COVER_LAYOUTS = ['bubble', 'cover', 'window'] as const;
export type CoverLayout = typeof COVER_LAYOUTS[number];
export const COVER_LAYOUT_LABELS: Record<CoverLayout | 'presenter', string> = {
    presenter: 'Presenter', bubble: 'Screen + bubble', cover: 'Screen only', window: 'Presenter + window',
};

/** What a cover can show. AI is left out on purpose: a cover never spends (the build's cost is unchanged). */
export const COVER_SOURCES = ['own_video', 'stock_video', 'stock_photo', 'product_photo'] as const;
export type CoverSource = typeof COVER_SOURCES[number];

export const CORNERS = ['br', 'bl', 'tr', 'tl'] as const;
export type Corner = typeof CORNERS[number];
export const CORNER_LABELS: Record<Corner, string> = { br: 'Bottom right', bl: 'Bottom left', tr: 'Top right', tl: 'Top left' };

export const BUBBLE_SIZES = ['small', 'medium'] as const;
export type BubbleSize = typeof BUBBLE_SIZES[number];

export interface SceneCover {
    layout: CoverLayout;
    source: CoverSource;
    /** own_video: one of the brief's own videos (the screen recording). product_photo: a library picture. */
    assetId?: number;
    /** own_video: where in that video to start, seconds. Absent = 0. */
    inS?: number;
    /** stock: 2–4 search words. Absent = the scene's own keywords or line. */
    keywords?: string;
    /** The part of the scene it covers, seconds into the scene. Absent = the whole scene. */
    fromS?: number;
    toS?: number;
    /** Bubble or window corner. Absent = the layout's default (bubble bottom right, window bottom left). */
    corner?: Corner;
    /** The bubble's size (D-W4: Small or Medium). Absent = medium. */
    size?: BubbleSize;
}

export const isCoverLayout = (v: unknown): v is CoverLayout => (COVER_LAYOUTS as readonly string[]).includes(String(v));
export const isCoverSource = (v: unknown): v is CoverSource => (COVER_SOURCES as readonly string[]).includes(String(v));
export const isCorner = (v: unknown): v is Corner => (CORNERS as readonly string[]).includes(String(v));
export const isBubbleSize = (v: unknown): v is BubbleSize => (BUBBLE_SIZES as readonly string[]).includes(String(v));

/** The corner a layout uses when none is chosen (D-W4: the bubble bottom right). */
export function cornerOf(cover: Pick<SceneCover, 'layout' | 'corner'>): Corner {
    return cover.corner ?? (cover.layout === 'window' ? 'bl' : 'br');
}

const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : undefined;
};
const words = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/**
 * A cover made safe, or null. `own` maps each of the brief's own videos to its measured length; `library` is
 * the workspace's pictures. An own video or picture that isn't theirs (or is gone) drops the cover rather than
 * guessing another. Pure.
 */
export function readSceneCover(raw: unknown, ctx: { own: Map<number, number>; library: Set<number> }): SceneCover | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (!isCoverLayout(o.layout) || !isCoverSource(o.source)) return null;
    const cover: SceneCover = { layout: o.layout, source: o.source };
    if (o.source === 'own_video' || o.source === 'product_photo') {
        const id = Number(o.assetId);
        if (!Number.isInteger(id) || id <= 0) return null;
        if (o.source === 'own_video' && !ctx.own.has(id)) return null;
        if (o.source === 'product_photo' && !ctx.library.has(id)) return null;
        cover.assetId = id;
    }
    if (o.source === 'own_video') {
        const len = ctx.own.get(cover.assetId!) ?? 0;
        const inS = num(o.inS);
        // Start inside the file, leaving at least a second to play.
        if (inS != null && inS > 0) cover.inS = Math.min(inS, Math.max(0, Math.round((len - 1) * 10) / 10));
        if (!cover.inS) delete cover.inS;
    }
    if (o.source === 'stock_video' || o.source === 'stock_photo') {
        const k = words(o.keywords, 80);
        if (k) cover.keywords = k;
    }
    const fromS = num(o.fromS);
    const toS = num(o.toS);
    if (fromS != null && fromS > 0) cover.fromS = fromS;
    if (toS != null && toS > (cover.fromS ?? 0) + 0.5) cover.toS = toS;
    if (isCorner(o.corner) && o.layout !== 'cover' && o.corner !== cornerOf({ layout: o.layout })) cover.corner = o.corner;
    if (o.layout === 'bubble' && o.size === 'small') cover.size = 'small';
    return cover;
}

/** The output-time window a cover takes inside its scene ([sceneStartS, sceneStartS + sceneLenS)). Null when nothing is left. Pure. */
export function coverWindow(cover: Pick<SceneCover, 'fromS' | 'toS'>, sceneStartS: number, sceneLenS: number): { startS: number; endS: number } | null {
    const from = Math.min(Math.max(0, cover.fromS ?? 0), sceneLenS);
    const to = Math.min(cover.toS ?? sceneLenS, sceneLenS);
    if (to - from < 0.5) return null;
    return { startS: r2(sceneStartS + from), endS: r2(sceneStartS + to) };
}

/** A cover on the finished timeline (ProjectTimeline.covers): resolved to an asset, timed in output seconds. */
export interface TimelineCover {
    id: string;
    assetId: number;
    kind: 'video' | 'image';
    startS: number;
    endS: number;
    /** Seconds into the cover's own file where it starts (video only). */
    inS?: number;
    layout: CoverLayout;
    corner?: Corner;
    size?: BubbleSize;
    /** A screen recording is letterboxed ('contain') so nothing on it is cropped; stock and pictures fill ('cover'). */
    fit: 'cover' | 'contain';
    /** A still picture's slow movement (still-motion.ts), when it has one. */
    motion?: string;
}

/** How long a clip plays on the timeline, from its own bounds. Pure. */
export function clipSeconds(c: Pick<VideoClip, 'kind' | 'holdS' | 'inS' | 'outS'>): number {
    if (c.kind === 'image') return c.holdS ?? 0;
    return c.outS != null ? Math.max(0, c.outS - (c.inS ?? 0)) : 0;
}

/**
 * The presenter's clips, split where a bubble or screen-only cover starts or ends, each piece carrying its
 * layout: 'bubble' (with the corner) under a bubble cover, 'hidden' under a screen-only cover (still heard).
 * A window cover needs nothing here — the presenter stays full frame and the window is drawn over it.
 * Only video clips are split (a still has no presenter). Clip times are seconds in each clip's source. Pure.
 */
export function applyCovers(clips: VideoClip[], covers: Array<Pick<TimelineCover, 'startS' | 'endS' | 'layout' | 'corner' | 'size'>>): VideoClip[] {
    const active = covers.filter((c) => c.layout !== 'window' && c.endS > c.startS);
    if (!active.length) return clips;
    const out: VideoClip[] = [];
    let t = 0;
    for (const clip of clips) {
        const len = clipSeconds(clip);
        const start = t, end = t + len;
        t = end;
        if (clip.kind === 'image' || len <= 0 || clip.outS == null) { out.push(clip); continue; }
        // Cut points inside this clip, in output time.
        const cuts = [...new Set(active.flatMap((c) => [c.startS, c.endS]).filter((x) => x > start + 0.04 && x < end - 0.04))].sort((a, b) => a - b);
        const edges = [start, ...cuts, end];
        for (let k = 0; k < edges.length - 1; k++) {
            const a = edges[k], b = edges[k + 1];
            const mid = (a + b) / 2;
            const cover = active.find((c) => mid >= c.startS && mid < c.endS);
            const piece: VideoClip = {
                ...clip,
                id: edges.length > 2 ? `${clip.id}_${String.fromCharCode(97 + k)}` : clip.id,
                inS: r2((clip.inS ?? 0) + (a - start)),
                outS: r2((clip.inS ?? 0) + (b - start)),
            };
            if (cover) {
                piece.layout = cover.layout === 'bubble' ? 'bubble' : 'hidden';
                if (cover.layout === 'bubble') { piece.corner = cover.corner ?? 'br'; if (cover.size === 'small') piece.size = 'small'; }
            }
            out.push(piece);
        }
    }
    return out;
}

/**
 * Seconds on the build's timeline → the frame the composition's <Series> actually reaches there. The build
 * times covers in seconds; the Series gives every clip a whole number of frames (rounded up), so clips drift
 * later than their seconds — half a frame each, more once applyCovers has split them. A screen timed from
 * absolute seconds then ended while its hidden presenter piece still played: black frames (review of #705).
 * Mapping through each clip's own start frame keeps a cover exactly on the pieces it covers. Pure.
 */
export function seriesClock(clips: Array<{ seconds: number; frames: number }>, fps: number): (t: number) => number {
    const at: Array<{ s: number; f: number; len: number; frames: number }> = [];
    let s = 0, f = 0;
    for (const c of clips) { at.push({ s, f, len: Math.max(0, c.seconds), frames: c.frames }); s += Math.max(0, c.seconds); f += c.frames; }
    return (t: number) => {
        for (let i = 0; i < at.length; i++) {
            const c = at[i];
            if (t <= c.s + 1e-6) return c.f;
            if (t < c.s + c.len - 1e-6) return c.f + Math.min(c.frames, Math.round((t - c.s) * fps));
        }
        return f;
    };
}

// ── Geometry (the composition and the Change form's preview share these numbers) ─────────────────

/** A bubble's place and size in pixels: a circle in the corner, 4 % of the short side from the edges (D-W4). */
export function bubbleBox(width: number, height: number, corner: Corner = 'br', size: BubbleSize = 'medium'): { left: number; top: number; size: number; ring: number } {
    const short = Math.min(width, height);
    const d = Math.round(short * (size === 'small' ? 0.2 : 0.26));
    const m = Math.round(short * 0.04);
    return {
        size: d,
        left: corner.endsWith('l') ? m : width - m - d,
        top: corner.startsWith('t') ? m : height - m - d,
        ring: Math.max(2, Math.round(short * 0.006)),
    };
}

/** A window's place and size in pixels: 32 % of the width, the frame's own shape, rounded corners. */
export function windowBox(width: number, height: number, corner: Corner = 'bl'): { left: number; top: number; width: number; height: number; radius: number } {
    const short = Math.min(width, height);
    const w = Math.round(width * (width >= height ? 0.32 : 0.46));
    const h = Math.round(w * (height / width));
    const m = Math.round(short * 0.04);
    return {
        width: w, height: h,
        left: corner.endsWith('l') ? m : width - m - w,
        top: corner.startsWith('t') ? m : height - m - h,
        radius: Math.round(short * 0.02),
    };
}

/**
 * How far bottom captions move up while a bubble or window sits at the bottom, as a percentage of the frame
 * height: clear of its top edge. 0 when nothing is at the bottom. Pure.
 */
export function captionLiftPct(width: number, height: number, at: { kind: 'bubble' | 'window'; corner: Corner; size?: BubbleSize } | null): number {
    if (!at || !at.corner.startsWith('b')) return 0;
    const top = at.kind === 'bubble' ? bubbleBox(width, height, at.corner, at.size).top : windowBox(width, height, at.corner).top;
    // Captions sit 21 % up (captions.ts captionLayout); lift them to 2 % above the box's top edge.
    const needed = ((height - top) / height) * 100 + 2 - 21;
    return Math.max(0, Math.round(needed * 10) / 10);
}

function r2(n: number): number { return Math.round(n * 100) / 100; }
