// src/utils/chat-post-parts.ts — the two cards behind "Select" in the social post editor's docked chat
// (owner 2026-11-05). A selected caption needs no card of its own: it comes back as the ordinary
// suggested caption. These cover the other two parts:
//
//   post_text_edit — one text box on the picture, shown before and after; "Use this" swaps its words
//                    and/or changes how it looks (`style`: font colour, font, box outline, box background
//                    and its transparency — the editor's own "Font, colour, outline and background"
//                    controls). Issue #95: the chat told a user it could only change a box's words, so
//                    "make the outline black" was a refusal and a wrong direction.
//   post_picture   — a new picture or video for the post. The chat cannot make or place one, so the card
//                    opens the editor's own picture step with the description filled in: the same search,
//                    the same Generate button and the same task charge as doing it by hand.
//
// Both act through the editor, on a click, and only while that post is open (workspace.html). Checked and
// rebuilt here because uiElementJson is stored and re-rendered on every reload. tests/post-chat-pane.test.ts.

// The faces the editor offers. Anything else would store a font the render cannot draw.
import { OVERLAY_FONTS } from '../lib/overlay-fonts';

export const POST_TEXT_EDIT_TYPE = 'post_text_edit';
export const POST_PICTURE_TYPE = 'post_picture';

const MAX_TEXT_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 300;

/**
 * How a text box looks — the same fields the editor stores on an overlay (image-overlay-editor.js).
 * Each is optional: absent = leave it as it is. `boxStroke` / `boxFill` null = switch it off.
 */
export interface TextBoxStyle {
    color?: string;
    fontFamily?: string;
    boxStroke?: string | null;
    boxFill?: string | null;
    boxOpacity?: number;
}
/** `replace` absent = keep the words; at least one of `replace` / `style` is always present. */
export interface PostTextEditCard { type: typeof POST_TEXT_EDIT_TYPE; postId: number; find: string; replace?: string; style?: TextBoxStyle; summary: string | null }
export interface PostPictureCard { type: typeof POST_PICTURE_TYPE; postId: number; kind: 'image' | 'video'; description: string; source?: 'library' }
export type PostPartCard = PostTextEditCard | PostPictureCard;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');


const NAMED_COLOURS: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
    orange: '#ffa500', pink: '#ffc0cb', purple: '#800080', grey: '#808080', gray: '#808080', navy: '#000080',
    gold: '#ffd700', silver: '#c0c0c0', brown: '#a52a2a', teal: '#008080',
};

/** A colour the <input type="color"> swatches can show: #rrggbb, lower case. #rgb and a few names are widened. */
export function normalizeHexColour(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim().toLowerCase();
    if (NAMED_COLOURS[t]) return NAMED_COLOURS[t];
    if (/^#[0-9a-f]{6}$/.test(t)) return t;
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
    return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
}

const OFF = new Set(['none', 'off', 'no', 'false', '']);

/** Checked field by field; an unreadable field is dropped, never guessed. Null when nothing usable is left. */
export function textBoxStyleFrom(v: unknown): TextBoxStyle | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const ui = v as Record<string, unknown>;
    const out: TextBoxStyle = {};
    const color = normalizeHexColour(ui.color);
    if (color) out.color = color;
    if (typeof ui.fontFamily === 'string') {
        const want = ui.fontFamily.trim().toLowerCase();
        const font = OVERLAY_FONTS.find((f) => f.id.toLowerCase() === want || f.label.toLowerCase() === want);
        if (font) out.fontFamily = font.id;
    }
    for (const key of ['boxStroke', 'boxFill'] as const) {
        if (!(key in ui)) continue;
        const raw = ui[key];
        if (raw === null || raw === false || (typeof raw === 'string' && OFF.has(raw.trim().toLowerCase()))) { out[key] = null; continue; }
        const hex = normalizeHexColour(raw);
        if (hex) out[key] = hex;
    }
    const op = typeof ui.boxOpacity === 'string' ? Number(ui.boxOpacity) : ui.boxOpacity;
    if (typeof op === 'number' && Number.isFinite(op)) out.boxOpacity = Math.min(1, Math.max(0, op));
    return Object.keys(out).length ? out : null;
}

export function postPartCardFromUiElement(uiElement: unknown): PostPartCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== POST_TEXT_EDIT_TYPE && ui.type !== POST_PICTURE_TYPE) return null;
    const postId = Number(String(ui.postId ?? '').replace(/^#/, ''));
    if (!Number.isInteger(postId) || postId <= 0) return null;
    if (ui.type === POST_PICTURE_TYPE) {
        // "source": "library" — one of their own, from My Content (owner, 2026-11-10).
        return { type: POST_PICTURE_TYPE, postId, kind: ui.kind === 'video' ? 'video' : 'image', description: str(ui.description, MAX_DESCRIPTION_CHARS), ...(ui.source === 'library' ? { source: 'library' as const } : {}) };
    }
    const find = str(ui.find, MAX_TEXT_CHARS);
    const replace = str(ui.replace, MAX_TEXT_CHARS);
    const style = textBoxStyleFrom(ui.style);
    if (!find || (!replace && !style)) return null;
    return {
        type: POST_TEXT_EDIT_TYPE, postId, find,
        ...(replace ? { replace } : {}),
        ...(style ? { style } : {}),
        summary: str(ui.summary, 300) || null,
    };
}

/**
 * The open post's text boxes as the chat's prompt lists them: their words EXACTLY (what "find" must
 * quote) and how each looks now. Without this the chat only saw a box when the user had pressed
 * Select on it, and "make the outline on the text box black" had nothing to name (issue #95).
 */
export function describeTextBoxes(overlays: unknown, max = 8): string[] {
    if (!Array.isArray(overlays)) return [];
    const out: string[] = [];
    for (const o of overlays) {
        if (!o || typeof o !== 'object') continue;
        const ov = o as Record<string, unknown>;
        const text = typeof ov.text === 'string' ? ov.text.trim() : '';
        if (!text) continue;
        const fill = normalizeHexColour(ov.boxFill);
        const opacity = typeof ov.boxOpacity === 'number' ? ov.boxOpacity : 1;
        const look = [
            `font colour ${normalizeHexColour(ov.color) || '#ffffff'}`,
            `font ${typeof ov.fontFamily === 'string' && ov.fontFamily ? ov.fontFamily : 'Arial'}`,
            `outline ${normalizeHexColour(ov.boxStroke) || 'off'}`,
            `background ${fill ? `${fill} at ${Math.round(opacity * 100)}% opacity` : 'off'}`,
        ].join(', ');
        out.push(`“${text.slice(0, MAX_TEXT_CHARS)}” (${look})`);
        if (out.length >= max) break;
    }
    return out;
}
