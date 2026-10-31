// src/lib/still-motion.ts
//
// Slow movement on a still picture (Video Producer plan, Phase 4) — the push-in or pan that stops a
// photo-into-video reading as a slideshow.
//
// Used today by the still backdrop of a render (a photo + voiceover post, the weekly YouTube Short);
// written as a pure function of progress so the Phase 5 storyboard can put the same movement on a
// still SCENE inside a multi-clip timeline without a second implementation.
//
// PURE and browser-safe: the Remotion bundle imports it (remotion/PostOverlay.tsx). No Node imports.

export type StillMotion = 'none' | 'push_in' | 'pull_out' | 'pan_left' | 'pan_right';
export const STILL_MOTIONS: readonly StillMotion[] = ['none', 'push_in', 'pull_out', 'pan_left', 'pan_right'];

/**
 * How far the picture travels over the whole clip: 6 % of its size. Enough to read as movement on a
 * phone, small enough that a brand card's words near the edge are not cropped away.
 */
export const STILL_MOTION_STRENGTH = 0.06;

export function isStillMotion(v: unknown): v is StillMotion {
    return typeof v === 'string' && (STILL_MOTIONS as readonly string[]).includes(v);
}

/** Ease in and out — a camera move that starts and stops, never a linear crawl. Pure. */
export function easeInOut(p: number): number {
    const x = Math.min(Math.max(p, 0), 1);
    return 0.5 - Math.cos(Math.PI * x) / 2;
}

/**
 * Scale and offset at `progress` (0..1 through the clip). Offsets are percentages of the picture's
 * own size, for a CSS translate. A pan holds a constant zoom so the picture always covers the frame
 * while it slides. Pure.
 */
export function stillMotionAt(motion: StillMotion | null | undefined, progress: number, strength = STILL_MOTION_STRENGTH): { scale: number; xPct: number; yPct: number } {
    const p = easeInOut(progress);
    // translate() runs before scale(), in the picture's own %, so the on-screen shift is scale × travel
    // while the overflow each side is (scale − 1) / 2 of the frame. Travel is the largest value that
    // keeps the frame covered: (s − 1) / (2s). Half the zoom would uncover a ~2 px sliver at 1080 px.
    const travel = (strength / (2 * (1 + strength))) * 100;
    switch (motion) {
        case 'push_in':   return { scale: 1 + strength * p, xPct: 0, yPct: 0 };
        case 'pull_out':  return { scale: 1 + strength * (1 - p), xPct: 0, yPct: 0 };
        case 'pan_left':  return { scale: 1 + strength, xPct: travel - 2 * travel * p, yPct: 0 };
        case 'pan_right': return { scale: 1 + strength, xPct: -travel + 2 * travel * p, yPct: 0 };
        default:          return { scale: 1, xPct: 0, yPct: 0 };
    }
}

/** The CSS transform for a frame. Pure. */
export function stillMotionTransform(motion: StillMotion | null | undefined, progress: number): string {
    const { scale, xPct, yPct } = stillMotionAt(motion, progress);
    return `scale(${scale.toFixed(5)}) translate(${xPct.toFixed(4)}%, ${yPct.toFixed(4)}%)`;
}
