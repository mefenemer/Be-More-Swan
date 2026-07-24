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
        fontFamily: ov.fontFamily || OVERLAY_DEFAULTS.fontFamily,
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
