// remotion/PostOverlay.tsx
//
// The video render composition: the base clip with each timed text overlay burned in. This is the
// server-side twin of the browser preview in workspace.html — it uses the SAME geometry
// (overlayBoxStyle from src/lib/overlay-geometry.ts) and the SAME visibility rule (a <Sequence> from
// startS to endS mirrors _rqOverlayVisibleAt), so what the reviewer drags on the canvas is what
// Remotion Lambda publishes.
//
// Font fidelity note: the editor offers OS fonts (Arial, Impact, Georgia…). Lambda's headless Chrome
// must have matching faces or it substitutes — the one place render and preview can diverge. See the
// deploy runbook (docs/remotion-render.md) for embedding faces; flagged, not yet solved.

import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence, useVideoConfig } from 'remotion';
import { overlayBoxStyle, overlayFrameRange, type Overlay } from '../src/lib/overlay-geometry';

export type PostOverlayProps = {
    videoSrc: string;
    overlays: Overlay[];
    // Frame metadata: the worker passes the base clip's real dimensions/fps/length; calculateMetadata
    // (Root.tsx) reads these so one composition serves every aspect ratio.
    width?: number;
    height?: number;
    fps?: number;
    durationInFrames?: number;
};

export const PostOverlay: React.FC<PostOverlayProps> = ({ videoSrc, overlays }) => {
    const { height, fps, durationInFrames } = useVideoConfig();
    const boxes = (overlays || []).filter((o) => o && String(o.text || '').trim());
    return (
        <AbsoluteFill style={{ backgroundColor: 'black' }}>
            <OffthreadVideo src={videoSrc} />
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
