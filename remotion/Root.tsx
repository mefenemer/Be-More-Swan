// remotion/Root.tsx
// Registers the one composition the render pipeline uses. Size / fps / duration are NOT fixed here —
// they come from the render request's inputProps via calculateMetadata, so a 9:16 Reel and a 1:1
// square both render from this single composition. The defaults below only shape the Studio preview.

import React from 'react';
import { Composition } from 'remotion';
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
            calculateMetadata={({ props }) => ({
                width: props.width ?? 1080,
                height: props.height ?? 1920,
                fps: props.fps ?? 30,
                durationInFrames: props.durationInFrames ?? 150,
            })}
        />
    );
};
