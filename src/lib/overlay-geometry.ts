// src/lib/overlay-geometry.ts
//
// Canonical geometry for post text overlays — the single source of truth shared by the server-side
// video render (the Remotion composition) and any other bundled consumer. The browser editor
// `src/components/image-overlay-editor.js` is a static, unbundled IIFE that cannot import this
// module, so it keeps its OWN inline copy of these constants; `tests/overlay-geometry.test.ts`
// asserts the two agree so a change here can never silently drift from what the user drags.
//
// WYSIWYG contract (unchanged from Phase 3): positions are 0..1 fractions of width/height, font size
// is a fraction of image/frame HEIGHT, and every box ratio below is the same in the DOM preview and
// the render. So a box dragged on the canvas lands in exactly the same place in the published media,
// at any resolution.

// Box ratios, all relative to the overlay's font size in pixels.
export const PAD_RATIO = 0.30;     // padding      = fontSize * PAD_RATIO
export const LINE_HEIGHT = 1.25;   // line height  = fontSize * LINE_HEIGHT
export const BORDER_RATIO = 0.07;  // border width = fontSize * BORDER_RATIO (min 1px)
export const RADIUS_RATIO = 0.15;  // corner radius= fontSize * RADIUS_RATIO

// Font-size clamp, as a fraction of the reference height. Matches the editor's slider bounds plus a
// hard floor/ceiling so a junk stored value can never blow the box up or shrink it to nothing.
export const FONT_MIN = 0.005;
export const FONT_MAX = 0.5;

import { overlayFontStack } from './overlay-fonts';

export interface Overlay {
    id: string;
    text: string;
    x: number;            // centre X, 0..1 of width
    y: number;            // centre Y, 0..1 of height
    fontFamily: string;
    fontSizePct: number;  // fraction of height
    color: string;
    boxStroke: string | null;
    boxFill: string | null;
    boxOpacity: number;   // 0..1 (1 = solid)
    startS?: number;      // video only: seconds the box appears (absent = from 0)
    endS?: number;        // video only: seconds the box disappears (absent = to the end)
    /**
     * How the box arrives and leaves. Video only: a still has no time for anything to happen in,
     * and its text is flattened into the pixels. Absent = 'none', which is how every overlay
     * written before this existed behaves.
     */
    anim?: OverlayAnim;
}

/** The ways a box can appear. Stored on the overlay, so never rename one. */
export type OverlayAnim = 'none' | 'fade' | 'rise' | 'pop';

export const OVERLAY_ANIMS: ReadonlyArray<{ id: OverlayAnim; label: string; hint: string }> = [
    { id: 'none', label: 'Cut',  hint: 'Appears and disappears instantly' },
    { id: 'fade', label: 'Fade', hint: 'Fades in and out' },
    { id: 'rise', label: 'Rise', hint: 'Slides up as it fades in' },
    { id: 'pop',  label: 'Pop',  hint: 'Springs up to size' },
];

const ANIM_IDS = new Set<string>(OVERLAY_ANIMS.map(a => a.id));

export function readOverlayAnim(v: unknown): OverlayAnim {
    return typeof v === 'string' && ANIM_IDS.has(v) ? (v as OverlayAnim) : 'none';
}

/**
 * How long the arrival and departure take. Capped at HALF the box's visible window, so a box shown
 * for a third of a second does not spend all of it fading — an animation that never finishes reads
 * as a rendering fault rather than a choice.
 */
export const OVERLAY_ANIM_S = 0.35;

/** easeOutBack: overshoots slightly and settles. What makes 'pop' read as a pop. */
function easeOutBack(t: number): number {
    const c = 1.70158;
    const u = t - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
}

const clamp01v = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The opacity and transform for one box at one frame of its own window.
 *
 * Pure, and deliberately not inside the composition: this is the one part of an animation that can
 * be wrong in a way nobody sees until a render comes back, so it is testable without a renderer.
 * `frame` is relative to the box's own Sequence; `frames` is how long that Sequence lasts.
 */
export function overlayAnimAt(
    anim: OverlayAnim | undefined, frame: number, frames: number, fps: number,
): { opacity: number; transform: string } {
    const kind = readOverlayAnim(anim);
    if (kind === 'none') return { opacity: 1, transform: 'none' };

    const total = Math.max(1, Math.floor(frames) || 1);
    const ramp = Math.max(1, Math.min(Math.round(OVERLAY_ANIM_S * fps), Math.floor(total / 2)));
    const f = Math.min(Math.max(Math.floor(frame) || 0, 0), total);

    const inP = clamp01v(f / ramp);
    const outP = clamp01v((total - f) / ramp);
    const p = Math.min(inP, outP);                 // whichever end we are nearer

    if (kind === 'fade') return { opacity: p, transform: 'none' };
    if (kind === 'rise') {
        // Rises on the way in and settles; on the way out it fades where it is rather than sinking,
        // which reads as the text leaving rather than falling over.
        const y = (1 - inP) * 4;                   // % of the frame height
        return { opacity: p, transform: y > 0.01 ? `translateY(${y}%)` : 'none' };
    }
    // pop
    const scale = inP >= 1 ? 1 : 0.82 + 0.18 * easeOutBack(inP);
    return { opacity: p, transform: Math.abs(scale - 1) > 0.001 ? `scale(${scale})` : 'none' };
}

export const OVERLAY_DEFAULTS = {
    fontFamily: 'Arial',
    fontSizePct: 0.07,
    color: '#ffffff',
    boxStroke: null as string | null,
    boxFill: '#000000' as string | null,
    boxOpacity: 0.5,
};

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function hexToRgba(hex: string | null, alpha: number): string {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return `rgba(0,0,0,${alpha})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

// The complete inline style for one overlay box, sized against a reference height in pixels. Returns
// camelCased CSS ready to spread onto a React element's `style` — it therefore also carries the
// layout bits the browser gets from the `.ioe-ov` CSS class (position, centring transform,
// line-height, pre-wrapping), so a Remotion `<div>` with no stylesheet renders identically.
// Defaults are applied defensively because stored overlays predate some fields.
export function overlayBoxStyle(ov: Partial<Overlay>, refHeightPx: number): Record<string, string | number> {
    const fontSize = clamp(ov.fontSizePct == null ? OVERLAY_DEFAULTS.fontSizePct : ov.fontSizePct, FONT_MIN, FONT_MAX) * refHeightPx;
    return {
        position: 'absolute',
        left: (clamp(ov.x ?? 0.5, 0, 1) * 100) + '%',
        top: (clamp(ov.y ?? 0.5, 0, 1) * 100) + '%',
        transform: 'translate(-50%, -50%)',
        boxSizing: 'border-box',
        whiteSpace: 'pre',
        overflow: 'visible',
        lineHeight: LINE_HEIGHT,
        // A STACK, not the bare stored name. Lambda has none of the OS fonts the picker offers and
        // substitutes silently, which moves the box as well as the letterforms — see
        // src/lib/overlay-fonts.ts. Every surface that draws an overlay resolves the name here, so
        // the preview and the published file cannot disagree about what 'Impact' means.
        fontFamily: overlayFontStack(ov.fontFamily),
        fontSize: fontSize + 'px',
        color: ov.color || OVERLAY_DEFAULTS.color,
        padding: (fontSize * PAD_RATIO) + 'px',
        borderRadius: (fontSize * RADIUS_RATIO) + 'px',
        border: ov.boxStroke ? `${Math.max(1, fontSize * BORDER_RATIO)}px solid ${ov.boxStroke}` : 'none',
        background: ov.boxFill ? hexToRgba(ov.boxFill, ov.boxOpacity == null ? 1 : ov.boxOpacity) : 'transparent',
    };
}

// Is an overlay visible at time `t` (seconds)? Absent bounds mean "always" — which is exactly how a
// still image treats every overlay, so images need no start/end at all.
export function overlayVisibleAt(ov: Pick<Overlay, 'startS' | 'endS'>, t: number): boolean {
    const start = ov.startS == null ? -Infinity : ov.startS;
    const end = ov.endS == null ? Infinity : ov.endS;
    return t >= start && t < end;
}

// The <Sequence> frame window for an overlay on a `durationInFrames`-long clip at `fps`. The
// server-side twin of overlayVisibleAt: the half-open [startS, endS) seconds become a from-frame and
// a length, clamped inside the clip so a box timed past the end still renders (Sequence would
// otherwise silently drop it). Absent start = frame 0; absent end = the whole clip.
export function overlayFrameRange(
    ov: Pick<Overlay, 'startS' | 'endS'>, fps: number, durationInFrames: number,
): { from: number; durationInFrames: number } {
    const from = Math.max(0, Math.min(durationInFrames - 1, ov.startS == null ? 0 : Math.round(ov.startS * fps)));
    const toExclusive = ov.endS == null ? durationInFrames : Math.round(ov.endS * fps);
    const frames = Math.max(1, Math.min(durationInFrames, toExclusive) - from);
    return { from, durationInFrames: frames };
}
