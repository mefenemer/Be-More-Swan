// src/lib/video-look.ts
//
// A colour look for a Video Producer video: one grade over every scene, so stock clips from four
// different photographers, an AI picture and the owner's own phone footage read as one film.
//
// 'brand' is built from the workspace's brand kit — a faint wash of the brand's main colour over the
// picture (soft-light, so skin tones survive) with a touch more contrast. The others are fixed grades.
// 'natural' (the default, and every video before 2026-11-10) changes nothing.
//
// Rendered by remotion/PostOverlay.tsx as a CSS filter on the picture layer plus a tint layer above it,
// both UNDER the captions and on-screen text, so words keep their exact colours. An older render
// bundle ignores the `look` prop and renders the picture ungraded.
//
// PURE. Tested in tests/video-producer-seven.test.ts.

export const VIDEO_LOOKS = ['natural', 'brand', 'warm', 'cool', 'punchy', 'mono'] as const;
export type VideoLook = typeof VIDEO_LOOKS[number];
export const LOOK_LABELS: Record<VideoLook, string> = {
    natural: 'Natural (no grade)', brand: 'Your brand colours', warm: 'Warm', cool: 'Cool', punchy: 'Bright and punchy', mono: 'Black and white',
};

export function isVideoLook(v: unknown): v is VideoLook {
    return (VIDEO_LOOKS as readonly string[]).includes(String(v));
}

/** What the composition draws. Absent = nothing. */
export interface LookStyle {
    /** CSS filter on the picture layer. */
    filter?: string;
    /** A colour washed over the picture (mix-blend soft-light). */
    tint?: string;
    tintOpacity?: number;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** A #rrggbb colour, or null. Pure. */
function hex(v: unknown): string | null {
    const s = String(v ?? '').trim();
    if (HEX.test(s)) return s.toLowerCase();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
    return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase() : null;
}

/** How saturated a colour is, 0..1 (HSL saturation). A grey brand colour makes no tint. Pure. */
export function saturation(colour: string): number {
    const h = hex(colour);
    if (!h) return 0;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return 0;
    return (max - min) / (1 - Math.abs(2 * l - 1));
}

/**
 * The look's drawing instructions. `brandColours` is the kit's colours in order of importance
 * (primary first); the first one with real colour in it tints the 'brand' look. Pure.
 */
export function lookStyle(look: unknown, brandColours: Array<string | null | undefined> = []): LookStyle | null {
    switch (isVideoLook(look) ? look : 'natural') {
        case 'brand': {
            const tint = brandColours.map(hex).find((c): c is string => !!c && saturation(c) >= 0.2);
            return tint ? { filter: 'contrast(1.06) saturate(1.05)', tint, tintOpacity: 0.18 } : { filter: 'contrast(1.06) saturate(1.08)' };
        }
        case 'warm': return { filter: 'saturate(1.1) contrast(1.04)', tint: '#ff9a3c', tintOpacity: 0.14 };
        case 'cool': return { filter: 'saturate(0.95) contrast(1.05)', tint: '#3c8dff', tintOpacity: 0.12 };
        case 'punchy': return { filter: 'saturate(1.3) contrast(1.12) brightness(1.03)' };
        case 'mono': return { filter: 'grayscale(1) contrast(1.1)' };
        default: return null;
    }
}
