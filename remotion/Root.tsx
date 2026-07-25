// remotion/Root.tsx
// Registers the one composition the render pipeline uses. Size / fps / duration are NOT fixed here —
// they come from the render request's inputProps via calculateMetadata, so a 9:16 Reel and a 1:1
// square both render from this single composition. The defaults below only shape the Studio preview.

import React from 'react';
import { Composition } from 'remotion';
import { getAudioDurationInSeconds, getImageDimensions, getVideoMetadata } from '@remotion/media-utils';
import { PostOverlay, type PostOverlayProps } from './PostOverlay';

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
                try {
                    if (props.videoSrc) {
                        const meta = await getVideoMetadata(props.videoSrc);
                        if (meta.width > 0 && meta.height > 0) { width = meta.width; height = meta.height; }
                        if (Number.isFinite(meta.durationInSeconds) && meta.durationInSeconds > 0) seconds = meta.durationInSeconds;
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
                return {
                    width: even(width),
                    height: even(height),
                    fps,
                    // Round UP: a half-frame of tail is better than clipping the last frame off.
                    durationInFrames: Math.max(1, Math.ceil(seconds * fps)),
                };
            }}
        />
    );
};
