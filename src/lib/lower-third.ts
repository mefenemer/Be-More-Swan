// src/lib/lower-third.ts
//
// Name captions ("lower thirds") for a Video Producer video: who is speaking, and what they do —
// "Sarah Jones · Owner" — shown for a few seconds at the start of their scene, in one of three styles
// the brief picks. Drawn with the ordinary text-overlay model (src/lib/overlay-geometry.ts), so it
// renders on every bundle, previews like any text box and needs nothing new in the composition.
//
// A scene gets one only when its storyboard says who is in it (scene.nameCaption) — the planner may
// name someone only from the brief, the business information or what the footage shows them saying;
// the owner can add, change or remove one on the scene.
//
// PURE. Tested in tests/video-producer-seven.test.ts.

import { PAD_RATIO, type Overlay } from './overlay-geometry';

export const LOWER_THIRD_STYLES = ['bar', 'clean', 'boxed'] as const;
export type LowerThirdStyle = typeof LOWER_THIRD_STYLES[number];
export const LOWER_THIRD_LABELS: Record<LowerThirdStyle, string> = {
    bar: 'Brand-colour bar, left', clean: 'Plain white words, left', boxed: 'White box, centred',
};
export function isLowerThirdStyle(v: unknown): v is LowerThirdStyle {
    return (LOWER_THIRD_STYLES as readonly string[]).includes(String(v));
}

export interface NameCaption { name: string; role?: string }

/** How long a name caption stays up, at most. */
export const LOWER_THIRD_S = 4;

const clean = (v: unknown, n: number) => String(typeof v === 'string' ? v : '').replace(/\s+/g, ' ').replace(/\b(?:https?:\/\/|www\.)\S+/gi, '').trim().slice(0, n);

/** A name caption from stored or model data, or null. Pure. */
export function readNameCaption(raw: unknown): NameCaption | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const name = clean(o.name, 40);
    if (!name) return null;
    const role = clean(o.role, 50);
    return role ? { name, role } : { name };
}

/**
 * The overlays for one name caption, starting `startS` into the video, for a scene `d` seconds long.
 * Sizes are fractions of the frame HEIGHT (as every text box is); `aspect` is width / height, so a
 * left-aligned box can be placed by its centre. It sits clear of the captions: above them when they
 * are at the bottom, at the bottom when they are at the top or middle. Pure.
 */
export function lowerThirdOverlays(args: {
    id: string; caption: NameCaption; startS: number; d: number; style?: LowerThirdStyle | null;
    accent?: string | null; aspect: number; captionPosition?: 'bottom' | 'middle' | 'top';
}): Overlay[] {
    const style: LowerThirdStyle = isLowerThirdStyle(args.style) ? args.style : 'bar';
    const from = Math.round((args.startS + Math.min(0.3, args.d / 4)) * 10) / 10;
    const until = Math.round((args.startS + Math.min(args.d, LOWER_THIRD_S + 0.3)) * 10) / 10;
    if (until - from < 1) return [];
    const nameY = args.captionPosition === 'top' ? 0.8 : args.captionPosition === 'middle' ? 0.74 : 0.6;
    const nameFont = args.aspect > 1 ? 0.052 : 0.036;
    const roleFont = Math.round(nameFont * 0.72 * 1000) / 1000;
    const roleY = Math.round((nameY + nameFont * 1.25 + roleFont * 0.9) * 1000) / 1000;
    // Anton is about half its height wide per character, plus the box's padding either side.
    const widthFrac = (text: string, font: string, size: number) =>
        ((font === 'Impact' ? 0.5 : 0.56) * text.length + 2 * PAD_RATIO) * size / args.aspect;
    const left = 0.06;
    const xFor = (text: string, font: string, size: number) =>
        style === 'boxed' ? 0.5 : Math.min(0.5, Math.round((left + widthFrac(text, font, size) / 2) * 1000) / 1000);
    const accent = /^#[0-9a-f]{6}$/i.test(String(args.accent ?? '')) ? String(args.accent) : '#111111';
    const look = style === 'bar'
        ? { name: { color: '#FFFFFF', boxFill: accent, boxOpacity: 0.92 }, role: { color: '#FFFFFF', boxFill: '#000000', boxOpacity: 0.6 } }
        : style === 'boxed'
            ? { name: { color: '#111111', boxFill: '#FFFFFF', boxOpacity: 0.95 }, role: { color: '#FFFFFF', boxFill: '#000000', boxOpacity: 0.6 } }
            : { name: { color: '#FFFFFF', boxFill: null, boxOpacity: 0 }, role: { color: '#FFFFFF', boxFill: null, boxOpacity: 0 } };
    const out: Overlay[] = [{
        id: `${args.id}_name`, text: args.caption.name, x: xFor(args.caption.name, 'Impact', nameFont), y: nameY,
        fontFamily: 'Impact', fontSizePct: nameFont, ...look.name, boxStroke: null, startS: from, endS: until, anim: 'rise',
    }];
    if (args.caption.role) {
        out.push({
            id: `${args.id}_role`, text: args.caption.role, x: xFor(args.caption.role, 'Arial', roleFont), y: roleY,
            fontFamily: 'Arial', fontSizePct: roleFont, ...look.role, boxStroke: null, startS: from, endS: until, anim: 'fade',
        });
    }
    return out;
}
