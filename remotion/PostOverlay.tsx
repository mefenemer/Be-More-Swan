// remotion/PostOverlay.tsx
//
// The video render composition: the base clip with each timed text overlay burned in. This is the
// server-side twin of the browser preview in workspace.html — it uses the SAME geometry
// (overlayBoxStyle from src/lib/overlay-geometry.ts) and the SAME visibility rule (a <Sequence> from
// startS to endS mirrors _rqOverlayVisibleAt), so what the reviewer drags on the canvas is what
// Remotion Lambda publishes.
//
// Fonts: the picker's names (Arial, Impact, Georgia…) are resolved to WEBFONT stacks by
// src/lib/overlay-fonts.ts, and useOverlayFonts below downloads them before the first frame is
// drawn. That is the fix for the one place render and preview could still diverge — Lambda's
// headless Chrome has none of those OS faces and substituted silently, moving the box as well as
// the letterforms because the box is sized by the rendered text. Proven and closed 2026-09-10;
// a local Mac render cannot catch a regression here, so verify on Lambda.

import React from 'react';
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, Series, continueRender, delayRender, useVideoConfig } from 'remotion';
import { overlayBoxStyle, overlayFrameRange, type Overlay } from '../src/lib/overlay-geometry';
import { audioGainAt } from '../src/lib/audio-overlays';
import { googleFamiliesFor, googleFontsHref } from '../src/lib/overlay-fonts';

/**
 * One clip of the timeline.
 *
 * `durationInFrames` is filled in by calculateMetadata (Root.tsx) once it has measured the file —
 * the component cannot measure anything, and a <Series.Sequence> has to be given a length. It stays
 * optional so the Studio preview, which renders straight from defaultProps, still shows something.
 */
export type TimelineClip = {
    id: string;
    src: string;
    /** Seconds into the source. Absent = the clip's own edge. */
    inS?: number;
    outS?: number;
    /**
     * 0..1 on the clip's OWN camera audio. Absent = play it as recorded. The decision is made
     * server-side (resolveClipGain in src/lib/video-edit.ts) so the render input shows the actual
     * mix rather than a rule that has to be re-derived to be understood.
     */
    gain?: number;
    durationInFrames?: number;
};

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
    /**
     * The trim on the base clip, in seconds against the SOURCE. Superseded by `clips` — kept only so
     * that props written by the previous deploy still render correctly, and normalised into the
     * timeline by timelineOf() rather than handled separately.
     */
    videoTrim?: { inS: number; outS: number | null };
    /**
     * The timeline: every clip, in order. When present this is what renders, and videoSrc/videoTrim
     * are ignored.
     *
     * Both forms exist on purpose, and the reason is a deploy hazard rather than indecision: the
     * renderer is an S3 bundle that a git push does NOT update, so there is always a window where
     * new inputProps meet an old bundle. An old bundle ignores `clips` and still finds `videoSrc`,
     * so the worst case is the first clip rendering untrimmed — not a failed render or a black
     * frame. The component normalises both into one timeline immediately, so there is still only
     * one rendering path below.
     */
    clips?: TimelineClip[];
    /** 'w:h' of the output frame. Set whenever the frame cannot be inherited from a single source. */
    targetRatio?: string;
    /**
     * Where the picture sits inside the frame when a clip has to be cropped to fill it. -1..1 per
     * axis, 0 centred — so -1 pins the left/top edge and +1 the right/bottom.
     *
     * Only ever set where a platform re-frames the master (Facebook and Threads today). Everywhere
     * else the frame IS the master's, nothing overflows, and this would have nothing to do.
     */
    framePosition?: { offsetX: number; offsetY: number };
    overlays: Overlay[];
    // Frame metadata: the worker passes the base clip's real dimensions/fps/length; calculateMetadata
    // (Root.tsx) reads these so one composition serves every aspect ratio.
    width?: number;
    height?: number;
    fps?: number;
    durationInFrames?: number;
};

/**
 * Both prop forms, collapsed into the one thing that renders.
 *
 * Exported because Root.tsx's calculateMetadata has to measure exactly the clips the component will
 * draw — two normalisations that could disagree would put the composition's length out of step with
 * its own content, which shows up as a frozen tail or a clip cut off mid-word.
 */
export function timelineOf(props: Pick<PostOverlayProps, 'clips' | 'videoSrc' | 'videoTrim'>): TimelineClip[] {
    const clips = (props.clips || []).filter((c) => c && c.src);
    if (clips.length) return clips;
    if (!props.videoSrc) return [];
    return [{
        id: 'base',
        src: props.videoSrc,
        ...(props.videoTrim?.inS ? { inS: props.videoTrim.inS } : {}),
        ...(props.videoTrim?.outS != null ? { outS: props.videoTrim.outS } : {}),
    }];
}

/**
 * Download the faces this render needs, and hold the render until they are usable.
 *
 * delayRender is the whole point. Without it the first frames draw in a fallback face while the
 * stylesheet is still in flight — and because Lambda renders chunks in PARALLEL across functions,
 * that is not "the first few frames of the video", it is the first few frames OF EVERY CHUNK,
 * scattered through the output. A local render is too fast to show it.
 *
 * Every exit path continues the render, including the failures. A font CDN having a bad minute must
 * degrade to a fallback face, never fail a paid render — and never hang one either, which is what an
 * un-continued handle does once Remotion's own timeout expires.
 */
function useOverlayFonts(families: string[]): void {
    const [handle] = React.useState(() => (families.length ? delayRender('Loading overlay fonts') : null));

    React.useEffect(() => {
        if (handle == null) return;
        let settled = false;
        const finish = () => { if (!settled) { settled = true; continueRender(handle); } };

        const href = googleFontsHref(families);
        if (!href || typeof document === 'undefined') { finish(); return; }

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);

        // Asking for each face by name is what actually triggers the download and tells us it
        // finished; appending the stylesheet alone only makes it available.
        Promise.all(families.map((f) => document.fonts.load(`400 100px "${f}"`).catch(() => undefined)))
            .then(() => document.fonts.ready)
            .then(finish)
            .catch(finish);

        // A ceiling of our own, comfortably inside Remotion's, so a stalled CDN costs seconds
        // rather than the whole job.
        const timer = setTimeout(finish, 10_000);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handle]);
}

export const PostOverlay: React.FC<PostOverlayProps> = ({ videoSrc, imageSrc, audio, videoTrim, clips, framePosition, overlays }) => {
    const { height, fps, durationInFrames } = useVideoConfig();
    const boxes = (overlays || []).filter((o) => o && String(o.text || '').trim());
    const tracks = (audio || []).filter((a) => a && a.src);
    const timeline = timelineOf({ clips, videoSrc, videoTrim });
    // Only the families these boxes actually name — a render with two overlays should not wait on
    // eight downloads, and a render with none should not wait at all.
    useOverlayFonts(googleFamiliesFor(boxes.map((b) => b.fontFamily)));
    // Only reached when calculateMetadata could not measure the files (the Studio preview, or every
    // source unreadable). Splitting the composition evenly is not accurate, but it keeps every clip
    // visible for the same share of the piece instead of collapsing them all onto frame 0.
    const evenShare = Math.max(1, Math.floor(durationInFrames / Math.max(1, timeline.length)));
    // -1..1 → the 0%..100% object-position CSS wants, with 0 landing on the 50% that means centred.
    // Only the overflowing axis moves, which is exactly what object-position already does: on the
    // axis that fits, every percentage renders the same picture.
    const pct = (offset: number) => `${((Math.min(Math.max(offset, -1), 1) + 1) / 2) * 100}%`;
    const objectPosition = framePosition
        ? `${pct(framePosition.offsetX)} ${pct(framePosition.offsetY)}`
        : undefined;
    return (
        <AbsoluteFill style={{ backgroundColor: 'black' }}>
            {/* The timeline when there is one, otherwise the still. objectFit 'contain' on the image
                so a photo whose ratio differs from the chosen format is letterboxed rather than
                cropped — the reviewer picked the picture, not a crop of it. Clips are 'cover'
                instead: once several clips share one stated frame, letterboxing each of them to its
                own shape would put black bars in the middle of a reel. */}
            {timeline.length
                ? <Series>
                    {timeline.map((c) => (
                        <Series.Sequence key={c.id} durationInFrames={c.durationInFrames ?? evenShare}>
                            <OffthreadVideo
                                src={c.src}
                                style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition }}
                                // The clip's own sound. Left undefined when nobody has an opinion,
                                // so Remotion's own default (full volume) applies and an untouched
                                // post sounds exactly as it always has.
                                volume={c.gain}
                                // Trim in FRAMES against the source. The sequence's own length is
                                // already the trimmed length (calculateMetadata does that
                                // arithmetic), so these only decide WHERE in the file playback
                                // starts and stops — both numbers must come from the same trim or
                                // the clip drifts against its own overlays.
                                //
                                // trimAfter is omitted rather than computed when the user left the
                                // out point alone: an explicit frame count derived from a measured
                                // duration would re-round the end of every untrimmed clip for no reason.
                                trimBefore={c.inS ? Math.max(0, Math.round(c.inS * fps)) : undefined}
                                trimAfter={c.outS != null ? Math.max(1, Math.round(c.outS * fps)) : undefined}
                            />
                        </Series.Sequence>
                    ))}
                  </Series>
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
                            // Volume as a FUNCTION of the frame, which is what finally makes
                            // fadeInS/fadeOutS mean something — they were stored, defaulted and
                            // passed in here for a month while this prop was a bare number, so
                            // every voice note and every track hard-cut. The maths is in
                            // audioGainAt() so it can be tested without a renderer, which is the
                            // only way the gap would have been caught.
                            //
                            // `f` is relative to this Sequence, so a fade is always measured from
                            // the clip's own edges wherever it sits on the timeline.
                            volume={(f) => audioGainAt({
                                frame: f,
                                durationInFrames: frames,
                                fps,
                                volume: a.volume == null ? 1 : a.volume,
                                fadeInS: a.fadeInS,
                                fadeOutS: a.fadeOutS,
                            })}
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
