// remotion/Root.tsx
// Registers the one composition the render pipeline uses. Size / fps / duration are NOT fixed here —
// they come from the render request's inputProps via calculateMetadata, so a 9:16 Reel and a 1:1
// square both render from this single composition. The defaults below only shape the Studio preview.

import React from 'react';
import { Composition } from 'remotion';
import { getAudioDurationInSeconds, getImageDimensions, getVideoMetadata } from '@remotion/media-utils';
import { PostOverlay, timelineOf, type PostOverlayProps, type TimelineClip } from './PostOverlay';
import { DEFAULT_TARGET_RATIO, MAX_TIMELINE_SECONDS, frameForRatio } from '../src/lib/video-edit';

const DEFAULT_PROPS: PostOverlayProps = {
    // A public sample so `npm run remotion:studio` previews something; real renders override every field.
    videoSrc: 'https://remotion.dev/bbb.mp4',
    overlays: [
        { id: 'demo1', text: 'FRESH ROAST', x: 0.5, y: 0.16, fontFamily: 'Impact', fontSizePct: 0.08, color: '#ffffff', boxStroke: null, boxFill: '#000000', boxOpacity: 0.5, startS: 0, endS: 2 },
        { id: 'demo2', text: 'open till 3', x: 0.5, y: 0.85, fontFamily: 'Georgia', fontSizePct: 0.05, color: '#ffe600', boxStroke: null, boxFill: null, boxOpacity: 1, startS: 2, endS: 5 },
    ],
    width: 1080, height: 1920, fps: 30, durationInFrames: 150,
};

export const RemotionRoot: React.FC = () => {
    return (
        <Composition
            id="PostOverlay"
            component={PostOverlay}
            durationInFrames={DEFAULT_PROPS.durationInFrames!}
            fps={DEFAULT_PROPS.fps!}
            width={DEFAULT_PROPS.width!}
            height={DEFAULT_PROPS.height!}
            defaultProps={DEFAULT_PROPS}
            // The SOURCE CLIP is the authority on size and length; the inputProps are the fallback.
            // This runs inside the renderer (a real browser), so it can measure the video the way the
            // reviewer's browser did. It matters because the props come from the client's <video>
            // element and content_assets stores no duration at all — a stale or defaulted number
            // would silently truncate the render, publishing a clip that stops mid-sentence.
            // Measured dimensions also mean the base video is never letterboxed into a frame of the
            // wrong aspect ratio, and the fractional overlay geometry lands identically at any size.
            calculateMetadata={async ({ props }) => {
                const fps = props.fps ?? 30;
                let width = props.width ?? 1080;
                let height = props.height ?? 1920;
                let seconds = (props.durationInFrames ?? 150) / fps;
                // Measured clips, with the per-sequence lengths the component needs. Returned as
                // props at the end so the file is opened once, not once here and again per frame.
                let measured: TimelineClip[] | null = null;
                const timeline = timelineOf(props);
                try {
                    if (timeline.length) {
                        // ── The frame is STATED, not inherited, as soon as there is more than one clip ──
                        // A single clip is still measured and rendered at its own size: an untouched
                        // video should come back the size it went in, not resampled to our idea of
                        // vertical. Several clips have no single source to inherit from — that is the
                        // whole point of a timeline — so the target ratio decides, defaulting to the
                        // 9:16 master that four of the six platforms take as-is.
                        const ratio = props.targetRatio ?? (timeline.length > 1 ? DEFAULT_TARGET_RATIO : null);
                        const frame = frameForRatio(ratio);
                        if (frame) { width = frame.width; height = frame.height; }

                        const clips: TimelineClip[] = [];
                        let total = 0;
                        for (const clip of timeline) {
                            let full: number | null = null;
                            try {
                                const meta = await getVideoMetadata(clip.src);
                                if (!frame && meta.width > 0 && meta.height > 0) { width = meta.width; height = meta.height; }
                                if (Number.isFinite(meta.durationInSeconds) && meta.durationInSeconds > 0) full = meta.durationInSeconds;
                            } catch { /* unreadable clip — fall back to its declared window below */ }

                            // The TRIM is intersected with the real file HERE, not upstream, for the
                            // same reason the duration is measured here at all: nothing server-side
                            // can open the video, so every trim that arrives was computed from numbers
                            // a browser reported about (possibly) a different asset. An out point past
                            // the end of the file clamps to the end rather than asking Remotion for
                            // frames that do not exist.
                            const inS = full != null ? Math.min(Math.max(clip.inS ?? 0, 0), full) : (clip.inS ?? 0);
                            const outS = clip.outS != null
                                ? (full != null ? Math.min(clip.outS, full) : clip.outS)
                                : full;
                            // A collapsed window (an in point past a shorter-than-expected file) falls
                            // back to the whole clip: a visible mistake beats a zero-length sequence,
                            // which is a hard Remotion error at the end of a paid render.
                            const span = outS != null && outS > inS ? outS - inS : (full ?? 0);
                            const useWhole = !(outS != null && outS > inS);

                            const durationInFrames = Math.max(1, Math.ceil(span * fps));
                            total += durationInFrames;
                            // Spread the ORIGINAL clip and override only what was measured. Listing
                            // fields by hand here silently dropped `gain` the moment phase 3 added
                            // it — these props REPLACE the ones the worker sent, so anything not
                            // copied forward is lost, and a lost gain is a reel that plays its own
                            // camera audio under the music with nothing to show why.
                            const { inS: _inS, outS: _outS, ...carried } = clip;
                            clips.push({
                                ...carried,
                                ...(useWhole ? {} : { inS, ...(outS != null ? { outS } : {}) }),
                                durationInFrames,
                            });
                        }

                        // The composition's length is the SUM of the sequences, not an independent
                        // calculation of it. Rounding each clip up and the whole piece separately
                        // would leave the last clip either clipped or frozen on its final frame.
                        if (total > 0) {
                            measured = clips;
                            seconds = Math.min(MAX_TIMELINE_SECONDS, total / fps);
                        }
                    } else if (props.imageSrc) {
                        // A STILL has no duration of its own, so the piece is exactly as long as its
                        // audio — this is the "voice note over a photo" case, and without it the
                        // render would fall back to a default length and cut the speech off.
                        const dims = await getImageDimensions(props.imageSrc);
                        if (dims.width > 0 && dims.height > 0) { width = dims.width; height = dims.height; }
                        seconds = 0;   // resolved from the audio below; a still contributes nothing
                    }
                } catch {
                    // Unreadable source (expired URL, odd container) — the render will fail on its own
                    // terms with a clearer error than a metadata exception here would give.
                }

                // Audio can outlast its backdrop: a 30s voice note over a 10s clip, or over a still
                // that has no length at all. Measure every track's real end and extend to fit, or the
                // render stops mid-sentence. Bounded clips are trusted as-is; unbounded ones have to
                // be measured, since "no end" means "until the audio runs out".
                for (const track of (props.audio ?? [])) {
                    if (!track?.src) continue;
                    const start = track.startS ?? 0;
                    if (track.endS != null) { seconds = Math.max(seconds, track.endS); continue; }
                    try {
                        const dur = await getAudioDurationInSeconds(track.src);
                        if (Number.isFinite(dur) && dur > 0) seconds = Math.max(seconds, start + dur);
                    } catch { /* unreadable clip — the others still set the length */ }
                }
                // Everything failed to measure (all sources unreadable). A zero-length composition is
                // a hard Remotion error, so fall back to the caller's snapshot.
                if (!(seconds > 0)) seconds = (props.durationInFrames ?? 150) / fps;
                // h264 chroma subsampling requires even dimensions; an odd one fails the encode at the
                // very end of an otherwise successful render.
                const even = (n: number) => { const r = Math.round(n); return r % 2 === 0 ? r : r + 1; };
                // Round UP: a half-frame of tail is better than clipping the last frame off.
                const durationInFrames = Math.max(1, Math.ceil(seconds * fps));

                // A <Series> covers exactly the sum of its sequences and NOTHING after it, so audio
                // that outlasts the footage would have played over black — the one regression the
                // move from a single <OffthreadVideo> to a timeline could introduce. Hold the last
                // clip's final frame for the overhang instead, which is what the still + voice note
                // case has always done with its image.
                if (measured?.length) {
                    const covered = measured.reduce((n, c) => n + (c.durationInFrames ?? 0), 0);
                    if (durationInFrames > covered) {
                        const last = measured[measured.length - 1];
                        last.durationInFrames = (last.durationInFrames ?? 0) + (durationInFrames - covered);
                    }
                }

                return {
                    width: even(width),
                    height: even(height),
                    fps,
                    durationInFrames,
                    // Hand the measured timeline to the component so the file is opened once here
                    // rather than re-measured per frame — and so the sequence lengths it draws are
                    // the exact ones this function summed to get durationInFrames.
                    ...(measured ? { props: { ...props, clips: measured } } : {}),
                };
            }}
        />
    );
};
