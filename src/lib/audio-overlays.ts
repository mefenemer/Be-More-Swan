// src/lib/audio-overlays.ts
//
// Timed audio on a post — voice notes and sound, placed the same way text is.
//
// ── One model, not two ──────────────────────────────────────────────────────────────────────────
// The ask was "audio over the whole post, OR audio at particular moments in the video". Those are
// the same thing: a clip with no start/end bounds IS the whole post. So this mirrors the text
// overlay model in src/lib/overlay-geometry.ts exactly — half-open [startS, endS) seconds, absent
// bounds meaning "always" — and everything already built for text timing works unchanged:
// overlayFrameRange translates both, the timeline draws both, and Remotion sequences both.
//
// Keeping one model is what stops "whole post audio" and "timed audio" drifting into two features
// with two sets of bugs.
//
// ── What a platform actually accepts ────────────────────────────────────────────────────────────
// No platform has an "image with sound" post. Instagram, Facebook, X and LinkedIn have no such
// format, so audio only ever reaches them INSIDE a video. That is why audio on a photo post is not
// a publishing feature but a rendering one: the still becomes an mp4 (see needsVideoRender below).
// Threads voice notes are the one true standalone-audio format, and they publish differently again.

import { normalizeCaptionStyle, type CaptionStyle } from './captions';

export interface AudioOverlay {
    id: string;
    /** content_assets.id of an uploaded/recorded audio asset. The bytes live in R2. */
    assetId: number;
    /** What the user called it — shown on the timeline track. */
    label?: string;
    startS?: number;   // absent = from the start
    endS?: number;     // absent = to the end
    /** 0..1. Lets a voice note sit over music, or duck a clip's own sound. */
    volume: number;
    /** Fade in/out in seconds — a hard cut into speech is jarring, and this is cheap to render. */
    fadeInS?: number;
    fadeOutS?: number;
    /**
     * Burn this clip's words into the video as captions (src/lib/captions.ts). Only a voiceover has
     * words to show, so only the voiceover panel sets it; absent on every other clip. A voiceover
     * with it absent is captioned too — `false` is the only way to turn captions off.
     */
    captions?: boolean;
    /** How those captions look (captions.ts CaptionStyle); absent = the original look. */
    captionStyle?: CaptionStyle;
    /**
     * Extra gain on top of `volume`, up to MAX_LEVEL (src/lib/loudness.ts): a quiet voice brought up
     * to the loudness target. Absent = 1. Only the Video Producer sets it; an older render bundle
     * ignores it and plays the track at `volume`.
     */
    level?: number;
    /**
     * Duck this track (a music bed) while someone speaks: inside each window, seconds from the
     * track's own start, the gain is multiplied by `volume` (0..1), with a short ramp either side.
     */
    duck?: AudioDuck;
}

export interface AudioDuck { volume: number; windows: Array<{ startS: number; endS: number }> }

/** The most extra gain a track may carry (+12 dB). */
export const MAX_LEVEL = 4;
/** How long a duck takes to come down and go back up. */
export const DUCK_RAMP_S = 0.25;

export const AUDIO_DEFAULTS = { volume: 1, fadeInS: 0.05, fadeOutS: 0.05 };

/** Hard ceiling on clips per post. Each one is a separate <Audio> in the render. */
export const MAX_AUDIO_OVERLAYS = 10;

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Normalise whatever the client sent. Deliberately permissive but bounded, exactly like
 * save-post-overlays' sanitise(): the editor owns the shape, this only stops malformed or unbounded
 * data reaching the DB and, later, the renderer.
 *
 * Returns null when the payload is not a usable array — the caller answers 422 rather than writing
 * junk that would fail mid-render.
 */
export function sanitiseAudioOverlays(raw: unknown): AudioOverlay[] | null {
    if (!Array.isArray(raw)) return null;
    if (raw.length > MAX_AUDIO_OVERLAYS) return null;
    const out: AudioOverlay[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') return null;
        const o = item as Record<string, unknown>;
        const assetId = Number(o.assetId);
        // No asset means nothing to play — drop it rather than render silence.
        if (!Number.isInteger(assetId) || assetId <= 0) continue;

        const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
        const startS = time(o.startS);
        let endS = time(o.endS);
        // A zero-length or inverted window degrades to "the whole post" rather than a clip that
        // never plays — same rule the text overlays use.
        if (startS != null && endS != null && endS <= startS) endS = undefined;

        out.push({
            id: typeof o.id === 'string' ? o.id.slice(0, 64) : `a${assetId}_${out.length}`,
            assetId,
            label: typeof o.label === 'string' ? o.label.slice(0, 120) : undefined,
            volume: o.volume == null ? AUDIO_DEFAULTS.volume : clamp01(Number(o.volume) || 0),
            fadeInS: time(o.fadeInS) ?? AUDIO_DEFAULTS.fadeInS,
            fadeOutS: time(o.fadeOutS) ?? AUDIO_DEFAULTS.fadeOutS,
            ...(startS != null ? { startS } : {}),
            ...(endS != null ? { endS } : {}),
            ...(typeof o.captions === 'boolean' ? { captions: o.captions } : {}),
            ...(o.captionStyle && typeof o.captionStyle === 'object' ? { captionStyle: normalizeCaptionStyle(o.captionStyle) } : {}),
            ...(typeof o.level === 'number' && Number.isFinite(o.level) && o.level > 0 && o.level !== 1 ? { level: Math.min(MAX_LEVEL, o.level) } : {}),
            ...(readDuck(o.duck) ? { duck: readDuck(o.duck)! } : {}),
        });
    }
    return out;
}

/** A duck from stored data, or null when it isn't one. At most 200 windows. Pure. */
export function readDuck(raw: unknown): AudioDuck | null {
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    if (!Array.isArray(d.windows)) return null;
    const windows = d.windows.slice(0, 200).flatMap((w) => {
        const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
        const a = Number(o.startS), b = Number(o.endS);
        return Number.isFinite(a) && Number.isFinite(b) && b > a && a >= 0 ? [{ startS: a, endS: b }] : [];
    });
    if (!windows.length) return null;
    return { volume: clamp01(Number(d.volume) || 0), windows };
}

/**
 * The duck multiplier at `t` seconds into the track: `volume` inside a window, 1 well outside, and a
 * straight ramp over DUCK_RAMP_S on each edge (outside the window, so speech is never caught loud). Pure.
 */
export function duckAt(duck: AudioDuck | null | undefined, t: number): number {
    if (!duck || !duck.windows.length) return 1;
    let m = 1;
    for (const w of duck.windows) {
        let k = 1;
        if (t >= w.startS && t < w.endS) k = duck.volume;
        else if (t < w.startS && t > w.startS - DUCK_RAMP_S) k = duck.volume + (1 - duck.volume) * ((w.startS - t) / DUCK_RAMP_S);
        else if (t >= w.endS && t < w.endS + DUCK_RAMP_S) k = duck.volume + (1 - duck.volume) * ((t - w.endS) / DUCK_RAMP_S);
        if (k < m) m = k;
    }
    return m;
}

/** Clips with something to play. Mirrors renderableOverlays() for text. */
export function renderableAudio(raw: unknown): AudioOverlay[] {
    if (!Array.isArray(raw)) return [];
    return (raw as AudioOverlay[]).filter(a => a && Number.isInteger(a.assetId) && a.assetId > 0);
}

/**
 * Does this post now need a server-side video render?
 *
 * TEXT overlays only force a render on a video (a photo's text bakes in the browser). AUDIO forces
 * one either way, and on a photo it forces one that did not exist before: a still with sound is not
 * a post any platform accepts, so the only way to publish it is to render the image and the audio
 * together into an mp4. That turns a photo post into a video post at approval time, which is a
 * bigger consequence than it looks — hence its own named function rather than an inline condition.
 */
export function needsVideoRender(params: {
    hasVideo: boolean;
    textOverlays: number;
    audioOverlays: number;
    /**
     * The post carries an edit that changes its media — a cut, or several clips to stitch
     * (editChangesMedia in src/lib/video-edit.ts). Like audio, an edit only exists once the file has
     * been re-encoded — no platform understands a "trimmed" or "stitched" flag — so it forces a
     * render on its own, even with nothing to burn in.
     *
     * It lives in this one function rather than as a second condition at the call sites because two
     * paths deciding independently whether a render is needed is exactly what produced the
     * silently-un-gated Short (see the comment block in trigger-post-render.ts).
     */
    hasEdit?: boolean;
}): boolean {
    if (params.audioOverlays > 0) return true;              // audio always has to be rendered in
    if (params.hasEdit && params.hasVideo) return true;     // a cut or a stitch only exists once re-encoded
    return params.hasVideo && params.textOverlays > 0;      // text: video only
}

/**
 * The gain for one audio track at one frame — its own volume, shaped by its fades.
 *
 * ── Why this is here and not in the composition ─────────────────────────────────────────────────
 * fadeInS/fadeOutS were stored, defaulted and passed all the way into the render for over a month
 * and then ignored: the composition set `volume` and nothing else, so every voice note and every
 * track hard-cut. Dead data of that kind is worse than a missing feature, because the editor offers
 * a control that demonstrably does nothing. The arithmetic lives in this pure module so it can be
 * tested without a renderer, which is the only way anyone would have noticed.
 *
 * `frame` is relative to the track's own sequence, not the composition — Remotion's volume callback
 * already works that way, and a fade has to be measured from the clip's own edges regardless of
 * where on the timeline it sits.
 *
 * Fades are capped at half the clip each, so a 0.5s fade on a 0.4s blip ramps up and straight back
 * down instead of overlapping into a gain above the one the user set.
 */
export function audioGainAt(params: {
    frame: number;
    durationInFrames: number;
    fps: number;
    volume: number;
    fadeInS?: number;
    fadeOutS?: number;
    /** Extra gain (AudioOverlay.level). Absent = 1, and the result stays within 0..1 as it always has. */
    level?: number;
    duck?: AudioDuck | null;
}): number {
    const total = Math.max(1, Math.floor(params.durationInFrames) || 1);
    const frame = Math.min(Math.max(Math.floor(params.frame) || 0, 0), total);
    const half = Math.floor(total / 2);
    const toFrames = (s: number | undefined) =>
        Math.min(Math.max(Math.round((s ?? 0) * params.fps) || 0, 0), half);

    const fadeIn = toFrames(params.fadeInS);
    const fadeOut = toFrames(params.fadeOutS);

    let gain = clamp01(params.volume);
    if (fadeIn > 0 && frame < fadeIn) gain *= frame / fadeIn;
    if (fadeOut > 0 && frame > total - fadeOut) gain *= (total - frame) / fadeOut;
    if (params.duck) gain *= duckAt(params.duck, frame / (params.fps || 30));
    const level = typeof params.level === 'number' && Number.isFinite(params.level) && params.level > 0 ? Math.min(MAX_LEVEL, params.level) : 1;
    return level === 1 ? clamp01(gain) : Math.min(MAX_LEVEL, Math.max(0, clamp01(gain) * level));
}

/**
 * The longest point any audio clip reaches, in seconds — or null when nothing is bounded.
 *
 * Needed because audio can outlast its backdrop. A 30s voice note over a 10s clip, or over a still
 * image (which has no duration at all), has to extend the render or it is cut off mid-sentence.
 * Clips with no endS are unbounded and can only be measured once their real duration is known, so
 * they are reported via `unbounded` for the caller to resolve from the assets themselves.
 */
export function audioExtentS(overlays: AudioOverlay[]): { boundedEndS: number; unbounded: AudioOverlay[] } {
    let boundedEndS = 0;
    const unbounded: AudioOverlay[] = [];
    for (const a of overlays) {
        if (a.endS != null) boundedEndS = Math.max(boundedEndS, a.endS);
        else unbounded.push(a);
    }
    return { boundedEndS, unbounded };
}
