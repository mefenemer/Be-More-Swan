// src/config/youtube-short.ts
// The shape of an autonomously drafted YouTube Short.
//
// ── What a Short is here ────────────────────────────────────────────────────────────────────────
// A brand card, rendered as a 10-second 1080×1920 video. Nothing more elaborate, and the plainness
// is deliberate:
//
//   • The card already carries the words. It is drawn server-side by satori/resvg from the org's own
//     brand kit, so the type is the org's type. A burned-in Remotion text overlay on top would be a
//     second copy of the same line — and it would be the one place fonts can substitute silently,
//     because Lambda's headless Chrome may not have the face (see the note in PostOverlay.tsx).
//     No overlay means that whole failure mode is out of scope.
//   • 9:16 is not cosmetic. The composition draws a still with objectFit:'contain' on black, so a
//     1:1 card in a 9:16 frame publishes as a letterboxed strip with fat bars. The card must be
//     generated at the Short's own ratio.
//   • Deterministic and free. No AI image credits, no video model, no provider that can refuse a
//     prompt — this runs unattended once a week, and the cheapest failure is the one that can't
//     happen.
//
// The AI-video route (Fal/Hailuo) is deliberately NOT this: its text-to-video endpoint takes no
// aspect ratio at all, so it cannot be made to satisfy yt_short's 9:16 requirement.

import type { AspectRatio } from '../lib/fal-gateway';

/** Seconds of video. Long enough to read the card, short enough that nobody waits. */
export const SHORT_DURATION_S = 10;

/** 1080×1920 — the standard Shorts frame. Even numbers, as h264 requires. */
export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;

/** The catalogue format (src/config/post-formats.ts): 9:16, video-mandatory, ≤180s. */
export const SHORT_FORMAT_KEY = 'yt_short';

/** The loose post_format several publishers branch on. 'video' is what the YouTube path expects. */
export const SHORT_POST_FORMAT = 'video';

export const SHORT_ASPECT: AspectRatio = '9:16';

/**
 * Media sources for a Short, overriding the assistant's own preference order.
 *
 * Brand card ONLY, and the exclusion matters more than the inclusion: stock and AI images come back
 * at whatever ratio the provider felt like, which the composition would letterbox. A Short with no
 * card (the org has no headline to draw) is drafted media-less and reported through the normal
 * media-exhausted path — visible, and fixable by the user — rather than published as a black frame
 * with a photo postage-stamped in the middle of it.
 */
export const SHORT_MEDIA_SOURCES = ['brand_card'] as const;

/** Is this the autonomous-Short format? Kept as a function so call sites read as intent, not string. */
export function isYoutubeShortFormat(formatKey: string | null | undefined): boolean {
    return formatKey === SHORT_FORMAT_KEY;
}
