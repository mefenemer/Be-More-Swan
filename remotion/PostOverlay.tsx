// remotion/PostOverlay.tsx
//
// The video render composition: the base clip with each timed text overlay burned in. This is the
// server-side twin of the browser preview in workspace.html — it uses the SAME geometry
// (overlayBoxStyle from src/lib/overlay-geometry.ts) and the SAME visibility rule (a <Sequence> from
// startS to endS mirrors _rqOverlayVisibleAt), so what the reviewer drags on the canvas is what
// Remotion Lambda publishes.
//
// Font fidelity note: the editor offers OS fonts (Arial, Impact, Georgia…). Lambda's headless Chrome
// must have matching faces or it substitutes SILENTLY — the one place render and preview can still
// diverge, and it moves the box as well as the letterforms because the box is sized by the rendered
// text. Local renders on a Mac cannot catch it (macOS has the real fonts). See "Fonts" in
// docs/remotion-render.md for the recommended fix; flagged, not yet solved.

import React from 'react';
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, useVideoConfig } from 'remotion';
import { overlayBoxStyle, overlayFrameRange, type Overlay } from '../src/lib/overlay-geometry';

/** A timed audio clip, already resolved to a fetchable URL by the worker. */
export type AudioTrack = {
    id: string;
    src: string;
    startS?: number;
    endS?: number;
    volume?: number;
    fadeInS?: number;
    fadeOutS?: number;
};

export type PostOverlayProps = {
    /** The base clip. Empty when the post is a STILL — see imageSrc. */
    videoSrc: string;
    /**
     * A still backdrop, used when there is no video. This is what makes "a voice note over a photo"
     * publishable at all: no platform accepts an image with sound, so the image and the audio are
     * rendered together into an mp4 here.
     */
    imageSrc?: string;
    audio?: AudioTrack[];
    overlays: Overlay[];
    // Frame metadata: the worker passes the base clip's real dimensions/fps/length; calculateMetadata
    // (Root.tsx) reads these so one composition serves every aspect ratio.
    width?: number;
    height?: number;
    fps?: number;
    durationInFrames?: number;
};

export const PostOverlay: React.FC<PostOverlayProps> = ({ videoSrc, imageSrc, audio, overlays }) => {
    const { height, fps, durationInFrames } = useVideoConfig();
    const boxes = (overlays || []).filter((o) => o && String(o.text || '').trim());
    const tracks = (audio || []).filter((a) => a && a.src);
    return (
        <AbsoluteFill style={{ backgroundColor: 'black' }}>
            {/* Video when there is one, otherwise the still. objectFit 'contain' on the image so a
                photo whose ratio differs from the chosen format is letterboxed rather than cropped —
                the reviewer picked the picture, not a crop of it. */}
            {videoSrc
                ? <OffthreadVideo src={videoSrc} />
                : imageSrc ? <Img src={imageSrc} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : null}

            {/* Timed audio. The same [startS, endS) window the text boxes use, through the same
                helper, so a voice note and a caption timed to the same moment land on the same
                frame. A clip with no bounds covers the whole piece. */}
            {tracks.map((a) => {
                const { from, durationInFrames: frames } = overlayFrameRange(
                    { startS: a.startS, endS: a.endS }, fps, durationInFrames,
                );
                return (
                    <Sequence key={a.id} from={from} durationInFrames={frames} layout="none">
                        <Audio
                            src={a.src}
                            volume={a.volume == null ? 1 : a.volume}
                            // Trim from the clip's own start: the Sequence decides WHEN it plays, so
                            // without this every clip would also skip its first `from` frames.
                            trimBefore={0}
                        />
                    </Sequence>
                );
            })}

            {boxes.map((ov) => {
                // Half-open [startS, endS) → a <Sequence> window, computed by the shared helper so it
                // stays in lockstep with the preview's visibility rule.
                const { from, durationInFrames: frames } = overlayFrameRange(ov, fps, durationInFrames);
                return (
                    <Sequence key={ov.id} from={from} durationInFrames={frames} layout="none">
                        <div style={overlayBoxStyle(ov, height) as React.CSSProperties}>{ov.text}</div>
                    </Sequence>
                );
            })}
        </AbsoluteFill>
    );
};
