// remotion/explainer/AssistantExplainer.tsx
//
// The overview video on each public assistant page (assistant.html). One composition, driven
// entirely by props built from db/assistant-showcases.json by scripts/render-assistant-videos.mjs:
//
//   1. Title     — the assistant's name and headline
//   2. Steps     — "How it works", one step at a time
//   3. Features  — a real product screenshot with a slow push-in where we have one, a designed
//                  card where we don't (never a mocked-up screen)
//   4. Close     — the highlights and the call to action
//
// Silent by design: it autoplays muted on the page, and captions carry every point.
//
// ⚠️ Its OWN entry point (remotion/explainer/index.ts), not remotion/Root.tsx. That root is the
// bundle deployed to Lambda for post renders and is drift-checked (scripts/stamp-remotion-bundle.mjs);
// a marketing composition has no business changing it. Rendered locally only.

import React from 'react';
import {
    AbsoluteFill, Img, Sequence, continueRender, delayRender, interpolate, spring, staticFile,
    useCurrentFrame, useVideoConfig,
} from 'remotion';

export type ExplainerFeature = { title: string; body: string; image?: string };
export type ExplainerProps = {
    name: string;
    headline: string;
    accent: string;
    steps: { title: string; body: string }[];
    features: ExplainerFeature[];
    highlights: string[];
};

export const FPS = 30;
export const TITLE_FRAMES = 150;
export const STEP_FRAMES = 90;
export const FEATURE_FRAMES = 210;
export const CLOSE_FRAMES = 180;

export function explainerDuration(p: ExplainerProps): number {
    return TITLE_FRAMES + p.steps.length * STEP_FRAMES + p.features.length * FEATURE_FRAMES + CLOSE_FRAMES;
}

const INK = '#1f1e1b';
const MUTED = '#5c574c';
const CREAM = '#fbf8f2';
const FONT = "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";

/** The brand font, loaded before the first frame so no frame is set in a fallback face. */
function useBrandFont() {
    const [handle] = React.useState(() => delayRender('brand font'));
    React.useEffect(() => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=block';
        document.head.appendChild(link);
        const done = () => continueRender(handle);
        link.onload = () => { document.fonts.ready.then(done, done); };
        link.onerror = done;
        const t = setTimeout(done, 8000);
        return () => clearTimeout(t);
    }, [handle]);
}

const fadeUp = (frame: number, start: number, fps: number) => {
    const s = spring({ frame: frame - start, fps, config: { damping: 200 } });
    return { opacity: s, transform: `translateY(${interpolate(s, [0, 1], [24, 0])}px)` };
};

/** Fades a whole scene in at its start and out at its end, so cuts never jump. */
const sceneFade = (frame: number, length: number) =>
    interpolate(frame, [0, 12, length - 12, length], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

const Title: React.FC<{ p: ExplainerProps }> = ({ p }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    return (
        <AbsoluteFill style={{ background: CREAM, opacity: sceneFade(frame, TITLE_FRAMES), padding: 110, justifyContent: 'center' }}>
            <div style={{ ...fadeUp(frame, 0, fps), fontSize: 22, fontWeight: 800, letterSpacing: 4, color: p.accent, textTransform: 'uppercase' }}>Be More Swan</div>
            <div style={{ ...fadeUp(frame, 8, fps), fontSize: 76, fontWeight: 800, color: INK, lineHeight: 1.05, marginTop: 18 }}>{p.name}</div>
            <div style={{ ...fadeUp(frame, 18, fps), fontSize: 34, fontWeight: 700, color: MUTED, lineHeight: 1.3, marginTop: 26, maxWidth: 980 }}>{p.headline}</div>
            <div style={{ position: 'absolute', left: 110, bottom: 90, height: 8, borderRadius: 4, background: p.accent,
                width: interpolate(frame, [20, 70], [0, 260], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }} />
        </AbsoluteFill>
    );
};

const Step: React.FC<{ p: ExplainerProps; i: number }> = ({ p, i }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const st = p.steps[i];
    return (
        <AbsoluteFill style={{ background: '#ffffff', opacity: sceneFade(frame, STEP_FRAMES), padding: 110, justifyContent: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 3, color: MUTED, textTransform: 'uppercase' }}>How it works</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 34, marginTop: 34 }}>
                <div style={{ ...fadeUp(frame, 0, fps), width: 120, height: 120, borderRadius: 60, background: p.accent, color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 62, fontWeight: 800, flexShrink: 0 }}>{i + 1}</div>
                <div>
                    <div style={{ ...fadeUp(frame, 6, fps), fontSize: 54, fontWeight: 800, color: INK, lineHeight: 1.1 }}>{st.title}</div>
                    <div style={{ ...fadeUp(frame, 14, fps), fontSize: 30, fontWeight: 500, color: MUTED, lineHeight: 1.4, marginTop: 14, maxWidth: 860 }}>{st.body}</div>
                </div>
            </div>
            <div style={{ position: 'absolute', left: 110, right: 110, bottom: 80, display: 'flex', gap: 10 }}>
                {p.steps.map((_, k) => <div key={k} style={{ flex: 1, height: 6, borderRadius: 3, background: k <= i ? p.accent : '#e8e3d8' }} />)}
            </div>
        </AbsoluteFill>
    );
};

const Feature: React.FC<{ p: ExplainerProps; i: number }> = ({ p, i }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const f = p.features[i];
    const caption = (
        <div style={{ width: 400, flexShrink: 0 }}>
            <div style={{ ...fadeUp(frame, 4, fps), fontSize: 20, fontWeight: 800, letterSpacing: 3, color: p.accent, textTransform: 'uppercase' }}>Key feature</div>
            <div style={{ ...fadeUp(frame, 10, fps), fontSize: 42, fontWeight: 800, color: INK, lineHeight: 1.12, marginTop: 14 }}>{f.title}</div>
            <div style={{ ...fadeUp(frame, 20, fps), fontSize: 24, fontWeight: 500, color: MUTED, lineHeight: 1.45, marginTop: 18 }}>{f.body}</div>
        </div>
    );
    if (f.image) {
        // A slow push-in across the scene: real screenshots, given motion without faking any UI.
        const zoom = interpolate(frame, [0, FEATURE_FRAMES], [1, 1.08]);
        return (
            <AbsoluteFill style={{ background: CREAM, opacity: sceneFade(frame, FEATURE_FRAMES), padding: '70px 70px 70px 90px', flexDirection: 'row', alignItems: 'center', gap: 56 }}>
                {caption}
                <div style={{ ...fadeUp(frame, 0, fps), flex: 1, borderRadius: 18, overflow: 'hidden', background: '#fff',
                    boxShadow: '0 30px 60px -25px rgba(31,30,27,.45)', border: '1px solid #e8e3d8' }}>
                    <div style={{ height: 30, background: '#f1ede4', display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 14 }}>
                        {['#f87171', '#fbbf24', '#34d399'].map((c) => <div key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c }} />)}
                    </div>
                    <div style={{ overflow: 'hidden' }}>
                        <Img src={staticFile(f.image.replace(/^\//, ''))} style={{ width: '100%', display: 'block', transform: `scale(${zoom})`, transformOrigin: '30% 20%' }} />
                    </div>
                </div>
            </AbsoluteFill>
        );
    }
    return (
        <AbsoluteFill style={{ background: CREAM, opacity: sceneFade(frame, FEATURE_FRAMES), padding: 110, justifyContent: 'center' }}>
            <div style={{ ...fadeUp(frame, 0, fps), background: '#fff', borderRadius: 28, padding: '60px 70px', border: '1px solid #e8e3d8',
                boxShadow: '0 30px 60px -30px rgba(31,30,27,.35)', borderLeft: `14px solid ${p.accent}` }}>
                <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 3, color: p.accent, textTransform: 'uppercase' }}>Key feature</div>
                <div style={{ ...fadeUp(frame, 8, fps), fontSize: 52, fontWeight: 800, color: INK, lineHeight: 1.1, marginTop: 16 }}>{f.title}</div>
                <div style={{ ...fadeUp(frame, 16, fps), fontSize: 28, fontWeight: 500, color: MUTED, lineHeight: 1.45, marginTop: 20 }}>{f.body}</div>
            </div>
        </AbsoluteFill>
    );
};

const Close: React.FC<{ p: ExplainerProps }> = ({ p }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    return (
        <AbsoluteFill style={{ background: INK, opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' }), padding: 110, justifyContent: 'center' }}>
            <div style={{ ...fadeUp(frame, 0, fps), fontSize: 56, fontWeight: 800, color: '#fff', lineHeight: 1.1 }}>Put the {p.name} to work.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px 40px', marginTop: 40 }}>
                {p.highlights.slice(0, 4).map((h, k) => (
                    <div key={h} style={{ ...fadeUp(frame, 10 + k * 6, fps), display: 'flex', alignItems: 'center', gap: 14, fontSize: 28, fontWeight: 700, color: '#f3efe6' }}>
                        <span style={{ color: p.accent, fontSize: 34 }}>✓</span>{h}
                    </div>
                ))}
            </div>
            <div style={{ ...fadeUp(frame, 40, fps), marginTop: 56, fontSize: 30, fontWeight: 800, color: p.accent }}>bemoreswan.com</div>
            <div style={{ ...fadeUp(frame, 46, fps), marginTop: 8, fontSize: 22, fontWeight: 500, color: '#b9b2a2' }}>Included in every plan. You approve its work before anything goes out.</div>
        </AbsoluteFill>
    );
};

export const AssistantExplainer: React.FC<ExplainerProps> = (p) => {
    useBrandFont();
    let at = 0;
    const seq = (len: number, el: React.ReactNode, key: string) => {
        const from = at;
        at += len;
        return <Sequence key={key} from={from} durationInFrames={len}>{el}</Sequence>;
    };
    return (
        <AbsoluteFill style={{ fontFamily: FONT, background: CREAM }}>
            {seq(TITLE_FRAMES, <Title p={p} />, 'title')}
            {p.steps.map((_, i) => seq(STEP_FRAMES, <Step p={p} i={i} />, `step${i}`))}
            {p.features.map((_, i) => seq(FEATURE_FRAMES, <Feature p={p} i={i} />, `feat${i}`))}
            {seq(CLOSE_FRAMES, <Close p={p} />, 'close')}
        </AbsoluteFill>
    );
};
