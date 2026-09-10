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
}

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
        });
    }
    return out;
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
    return clamp01(gain);
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
