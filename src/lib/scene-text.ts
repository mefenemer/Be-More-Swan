// src/lib/scene-text.ts
// The words on a Video Producer scene, as the owner sets them (docs/video-producer-manual-controls-plan.md
// Phase 2, 2026-11-10): where they sit, when they show, how they look, how they appear. One line per scene
// (decision D-T1); the font is the brand's when the render has it, otherwise Impact (D-T2).
//
// Every field is optional on the scene, and absent means exactly what the build did before this
// existed (upper third, the whole scene — the first 3 s over own footage — dark box, rise), so old
// storyboards render as they did.
//
// PURE: no database, no network. Tested in tests/video-scene-text.test.ts.

import { overlayFont } from './overlay-fonts';

export const TEXT_POSITIONS = ['top', 'middle', 'bottom'] as const;
export type TextPos = typeof TEXT_POSITIONS[number];
export const TEXT_WHENS = ['scene', 'first', 'last', 'words'] as const;
export type TextWhen = typeof TEXT_WHENS[number];
export const TEXT_STYLES = ['dark', 'plain', 'brand'] as const;
export type TextStyle = typeof TEXT_STYLES[number];
export const TEXT_ANIMS = ['none', 'fade', 'rise', 'pop'] as const;
export type TextAnim = typeof TEXT_ANIMS[number];

export const TEXT_POS_LABELS: Record<TextPos, string> = { top: 'Top', middle: 'Middle', bottom: 'Bottom' };
export const TEXT_WHEN_LABELS: Record<TextWhen, string> = { scene: 'The whole scene', first: 'The first 3 seconds', last: 'The last 3 seconds', words: 'While its words are said' };
export const TEXT_STYLE_LABELS: Record<TextStyle, string> = { dark: 'Dark box', plain: 'Plain (light backing)', brand: 'Brand-colour box' };
export const TEXT_ANIM_LABELS: Record<TextAnim, string> = { none: 'Cut', fade: 'Fade', rise: 'Rise', pop: 'Pop' };

const isOf = <T extends string>(list: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
export const isTextPos = isOf(TEXT_POSITIONS);
export const isTextWhen = isOf(TEXT_WHENS);
export const isTextStyle = isOf(TEXT_STYLES);
export const isTextAnim = isOf(TEXT_ANIMS);

/** "First 3 seconds" / "last 3 seconds", and how long a title sits over the owner's own take. */
export const TEXT_EDGE_S = 3;

export interface SceneTextFields { textPos?: TextPos; textWhen?: TextWhen; textStyle?: TextStyle; textAnim?: TextAnim }

/** The valid fields of an untrusted object (a model's scene, a patch, a chat card). Pure. */
export function readSceneText(o: Record<string, unknown> | null | undefined): SceneTextFields {
    const out: SceneTextFields = {};
    if (!o) return out;
    if (isTextPos(o.textPos)) out.textPos = o.textPos;
    if (isTextWhen(o.textWhen)) out.textWhen = o.textWhen;
    if (isTextStyle(o.textStyle)) out.textStyle = o.textStyle;
    if (isTextAnim(o.textAnim)) out.textAnim = o.textAnim;
    return out;
}

/** Where the words sit when the owner hasn't said: clear of the captions (upper third, or lower when captions are at the top). */
export function defaultTextPos(captionPosition: 'bottom' | 'middle' | 'top'): TextPos {
    return captionPosition === 'top' ? 'bottom' : 'top';
}

/**
 * The planner's placements, kept clear of the captions: a textPos where the captions sit is dropped, so
 * the words fall back to the default (clear of them). Only for what the PLANNER wrote — an owner's own
 * choice is theirs, and the Change form warns them instead. Pure.
 */
export function plannedClearOfCaptions<T extends { scenes: Array<{ textPos?: TextPos }> }>(storyboard: T, brief: { captions?: boolean; captionStyle?: { position?: string } | null }): T {
    if (brief.captions === false) return storyboard;
    const cap = brief.captionStyle?.position ?? 'bottom';
    return { ...storyboard, scenes: storyboard.scenes.map((s) => (s.textPos && s.textPos === cap ? (({ textPos: _p, ...rest }) => rest)(s) : s)) };
}

/** The centre Y (0..1) of each position — the same upper/lower thirds the build always used. */
export function textY(pos: TextPos): number {
    return pos === 'top' ? 0.2 : pos === 'middle' ? 0.5 : 0.7;
}

/** Would the words land on the captions? (The form says so; the build never moves them silently.) Pure. */
export function textMeetsCaptions(pos: TextPos, captionPosition: 'bottom' | 'middle' | 'top', captionsOn: boolean): boolean {
    return captionsOn && pos === captionPosition;
}

/**
 * When the words show, in seconds on the timeline. `t` is the scene's start and `d` its length;
 * `spoken` is the scene's spoken stretch (from the voiceover's word timings) for 'words'.
 * Default: the whole scene, or the first 3 s over the owner's own take (a title, not a subtitle). Pure.
 */
export function textWindow(when: TextWhen | undefined, t: number, d: number, opts: { ownVideo?: boolean; spoken?: { startS: number; endS: number } | null } = {}): { startS: number; endS: number } {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const edge = Math.min(TEXT_EDGE_S, d);
    const w = when ?? (opts.ownVideo && d > TEXT_EDGE_S + 1 ? 'first' : 'scene');
    if (w === 'first') return { startS: r1(t), endS: r1(t + edge) };
    if (w === 'last') return { startS: r1(t + d - edge), endS: r1(t + d) };
    if (w === 'words' && opts.spoken && opts.spoken.endS > opts.spoken.startS) {
        const s = Math.max(t, opts.spoken.startS), e = Math.min(t + d, opts.spoken.endS + 0.3);
        if (e - s >= 0.5) return { startS: r1(s), endS: r1(e) };
    }
    return { startS: r1(t), endS: r1(t + d) };
}

/** Black or white words on a brand colour, whichever reads. Pure. */
export function inkOn(hex: string | null | undefined): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
    if (!m) return '#FFFFFF';
    const n = parseInt(m[1], 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? '#000000' : '#FFFFFF';
}

/**
 * The box and ink for a style. 'plain' keeps a faint backing: overlays have no text shadow in the
 * renderer, and white words with no backing vanish on a bright clip. Pure.
 */
export function textLook(style: TextStyle | undefined, accent: string | null | undefined): { color: string; boxFill: string; boxOpacity: number } {
    if (style === 'plain') return { color: '#FFFFFF', boxFill: '#000000', boxOpacity: 0.25 };
    if (style === 'brand' && /^#?[0-9a-f]{6}$/i.test(String(accent ?? '').trim())) {
        const fill = String(accent).trim().startsWith('#') ? String(accent).trim() : `#${String(accent).trim()}`;
        return { color: inkOn(fill), boxFill: fill.toUpperCase(), boxOpacity: 0.92 };
    }
    return { color: '#FFFFFF', boxFill: '#000000', boxOpacity: 0.55 };
}

/** The brand's font when the renderer has it (overlay-fonts.ts), otherwise Impact — what every scene used before. Pure. */
export function textFont(brandFont: string | null | undefined): string {
    const want = String(brandFont ?? '').trim().toLowerCase();
    const f = overlayFont(want);
    return want && f.id.toLowerCase() === want ? f.id : 'Impact';
}
