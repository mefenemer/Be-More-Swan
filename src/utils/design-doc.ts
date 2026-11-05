// src/utils/design-doc.ts — a design you can edit: the Brand Designer's studio works on this (owner 2026-11-05: preview
// on the left, chat on the right, change anything on it, "very much like in Canva").
//
// A design is a page colour, one picture, and layers on top, every position a fraction of the trimmed page and every
// type size a fraction of its height. The browser (design-studio.js) and the renderer (src/lib/design-render.ts) use
// the same numbers, so what is dragged on screen is what prints.
//
// Pure: no DB, no renderer. Everything a browser or a chat card sends comes through here, so a colour is a colour, a
// font name can go in a font URL, and a picture or QR code can only ever be one the server put there.

import { cleanFontFamily, normalizeHex } from './brand-kit';

export const DESIGN_LIMITS = { layers: 40, text: 600, minFontPct: 0.006, maxFontPct: 0.3 } as const;
/** Padding of a text box with a background, as a share of its type size. Shared with design-studio.js. */
export const BOX_PAD_RATIO = 0.35;
export const LINE_HEIGHT = 1.25;

/** Where the picture lives. Only ever written by the server. */
export interface DesignPhotoRef {
    source?: string; storageKey: string | null; externalUrl: string | null; mimeType: string;
    width: number | null; height: number | null; attributionName?: string | null; attributionUrl?: string | null;
}

export interface DesignPhoto { x: number; y: number; w: number; h: number; opacity: number; ref: DesignPhotoRef }

export interface TextLayer {
    id: string; kind: 'text'; role: string; text: string;
    x: number; y: number; w: number;
    fontFamily: string | null; fontSizePct: number; bold: boolean; align: 'left' | 'center' | 'right';
    color: string; boxFill: string | null; boxOpacity: number;
}
export interface ShapeLayer { id: string; kind: 'shape'; role: string; x: number; y: number; w: number; h: number; color: string; round: boolean; opacity: number }
/** A QR code or logo: `src` is set by the server when the design is made, and never taken from a browser. */
export interface ImageLayer { id: string; kind: 'qr' | 'logo'; role: string; x: number; y: number; w: number; h: number; src: string }
export type DesignLayer = TextLayer | ShapeLayer | ImageLayer;

export interface Design {
    v: 1;
    kind: 'flyer' | 'image';
    /** The page in millimetres (flyer) or pixels (image): only the shape matters here. */
    pageW: number; pageH: number;
    paperSize: string | null;
    pageColor: string;
    photo: DesignPhoto | null;
    layers: DesignLayer[];
}

const num = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r/g, '').slice(0, max) : '');
const ALIGN = ['left', 'center', 'right'] as const;
const align = (v: unknown, fallback: TextLayer['align']): TextLayer['align'] => (ALIGN as readonly unknown[]).includes(v) ? v as TextLayer['align'] : fallback;
const cleanId = (v: unknown, fallback: string): string => { const s = String(v ?? ''); return /^[\w-]{1,40}$/.test(s) ? s : fallback; };

function textLayer(raw: Record<string, unknown>, id: string, base?: TextLayer): TextLayer {
    return {
        id, kind: 'text', role: cleanId(raw.role ?? base?.role, 'text'),
        text: raw.text !== undefined ? text(raw.text, DESIGN_LIMITS.text) : base?.text ?? '',
        x: num(raw.x, -0.5, 1.5, base?.x ?? 0.1), y: num(raw.y, -0.5, 1.5, base?.y ?? 0.1), w: num(raw.w, 0.03, 1.5, base?.w ?? 0.8),
        fontFamily: raw.fontFamily === null ? null : cleanFontFamily(raw.fontFamily) ?? base?.fontFamily ?? null,
        fontSizePct: num(raw.fontSizePct, DESIGN_LIMITS.minFontPct, DESIGN_LIMITS.maxFontPct, base?.fontSizePct ?? 0.03),
        bold: raw.bold !== undefined ? !!raw.bold : base?.bold ?? false,
        align: align(raw.align, base?.align ?? 'left'),
        color: normalizeHex(raw.color) ?? base?.color ?? '#1f1e1b',
        boxFill: raw.boxFill === null ? null : normalizeHex(raw.boxFill) ?? base?.boxFill ?? null,
        boxOpacity: num(raw.boxOpacity, 0, 1, base?.boxOpacity ?? 1),
    };
}

/**
 * What a browser sent, made safe, on top of what is stored. The picture's location and any QR or logo image can only
 * come from `stored`: a browser may move them or remove them, never point them somewhere else.
 */
export function normaliseDesign(raw: unknown, stored: Design): Design {
    const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const storedById = new Map(stored.layers.map((l) => [l.id, l]));
    const seen = new Set<string>();
    const layers: DesignLayer[] = [];
    for (const item of Array.isArray(r.layers) ? r.layers : []) {
        if (!item || typeof item !== 'object' || layers.length >= DESIGN_LIMITS.layers) continue;
        const l = item as Record<string, unknown>;
        const id = cleanId(l.id, `t${layers.length}`);
        if (seen.has(id)) continue;
        seen.add(id);
        const was = storedById.get(id);
        if (l.kind === 'text') layers.push(textLayer(l, id, was?.kind === 'text' ? was : undefined));
        else if (l.kind === 'shape' && was?.kind === 'shape') {
            layers.push({ ...was, x: num(l.x, -1, 2, was.x), y: num(l.y, -1, 2, was.y), w: num(l.w, 0.01, 2, was.w), h: num(l.h, 0.01, 2, was.h), color: normalizeHex(l.color) ?? was.color, opacity: num(l.opacity, 0, 1, was.opacity) });
        } else if ((l.kind === 'qr' || l.kind === 'logo') && was && was.kind === l.kind) {
            layers.push({ ...was, x: num(l.x, -0.5, 1.5, was.x), y: num(l.y, -0.5, 1.5, was.y), w: num(l.w, 0.02, 1.5, was.w), h: num(l.h, 0.02, 1.5, was.h) });
        }
    }
    const p = r.photo && typeof r.photo === 'object' ? r.photo as Record<string, unknown> : null;
    return {
        ...stored,
        pageColor: normalizeHex(r.pageColor) ?? stored.pageColor,
        photo: stored.photo && p ? {
            ref: stored.photo.ref,
            x: num(p.x, -1, 2, stored.photo.x), y: num(p.y, -1, 2, stored.photo.y),
            w: num(p.w, 0.02, 3, stored.photo.w), h: num(p.h, 0.02, 3, stored.photo.h),
            opacity: num(p.opacity, 0, 1, stored.photo.opacity),
        } : null,
        layers,
    };
}

// ── A change from the chat ──────────────────────────────────────────────────────────────────────

export const DESIGN_EDIT_TYPE = 'design_edit';

export interface DesignLayerChange {
    /** A layer's id, or its role: headline, subheading, points, offer, callToAction, dateLine, contact, wordmark. */
    layer: string;
    text?: string; color?: string; fontFamily?: string; fontSizePct?: number; bold?: boolean;
    align?: TextLayer['align']; boxFill?: string | null; boxOpacity?: number;
    x?: number; y?: number; w?: number; remove?: boolean;
}
export interface DesignEditCard {
    type: typeof DESIGN_EDIT_TYPE; briefId: number; optionId: number; summary: string | null;
    pageColor?: string; photoOpacity?: number; font?: string;
    changes: DesignLayerChange[];
    add: Array<{ text: string; x?: number; y?: number; w?: number; color?: string; fontSizePct?: number; bold?: boolean; boxFill?: string | null; boxOpacity?: number }>;
}

/** The card, rebuilt: uiElementJson is stored and re-rendered on every reload. Null when it changes nothing. */
export function designEditFromUiElement(uiElement: unknown): DesignEditCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== DESIGN_EDIT_TYPE) return null;
    const briefId = Number(String(ui.briefId ?? '').replace(/^#/, ''));
    const optionId = Number(String(ui.optionId ?? '').replace(/^#/, ''));
    if (!Number.isInteger(briefId) || briefId <= 0 || !Number.isInteger(optionId) || optionId <= 0) return null;
    const card: DesignEditCard = { type: DESIGN_EDIT_TYPE, briefId, optionId, summary: typeof ui.summary === 'string' ? ui.summary.trim().slice(0, 300) || null : null, changes: [], add: [] };
    const page = normalizeHex(ui.pageColor);
    if (page) card.pageColor = page;
    if (ui.photoOpacity !== undefined && Number.isFinite(Number(ui.photoOpacity))) card.photoOpacity = num(ui.photoOpacity, 0, 1, 1);
    const font = cleanFontFamily(ui.font);
    if (font) card.font = font;
    for (const c of (Array.isArray(ui.changes) ? ui.changes : []).slice(0, DESIGN_LIMITS.layers)) {
        if (!c || typeof c !== 'object') continue;
        const o = c as Record<string, unknown>;
        const layer = cleanId(o.layer, '');
        if (!layer) continue;
        const out: DesignLayerChange = { layer };
        if (o.remove === true) { out.remove = true; card.changes.push(out); continue; }
        if (typeof o.text === 'string' && o.text.trim()) out.text = text(o.text, DESIGN_LIMITS.text);
        const color = normalizeHex(o.color); if (color) out.color = color;
        const f = cleanFontFamily(o.fontFamily); if (f) out.fontFamily = f;
        if (Number.isFinite(Number(o.fontSizePct)) && o.fontSizePct !== null) out.fontSizePct = num(o.fontSizePct, DESIGN_LIMITS.minFontPct, DESIGN_LIMITS.maxFontPct, 0.03);
        if (typeof o.bold === 'boolean') out.bold = o.bold;
        if ((ALIGN as readonly unknown[]).includes(o.align)) out.align = o.align as TextLayer['align'];
        if (o.boxFill === null) out.boxFill = null; else { const b = normalizeHex(o.boxFill); if (b) out.boxFill = b; }
        if (o.boxOpacity !== undefined && Number.isFinite(Number(o.boxOpacity))) out.boxOpacity = num(o.boxOpacity, 0, 1, 1);
        for (const k of ['x', 'y', 'w'] as const) if (o[k] !== undefined && o[k] !== null && Number.isFinite(Number(o[k]))) out[k] = num(o[k], -0.5, 1.5, 0.1);
        if (Object.keys(out).length > 1) card.changes.push(out);
    }
    for (const a of (Array.isArray(ui.add) ? ui.add : []).slice(0, 5)) {
        if (!a || typeof a !== 'object') continue;
        const o = a as Record<string, unknown>;
        const t = text(o.text, DESIGN_LIMITS.text).trim();
        if (!t) continue;
        card.add.push({
            text: t,
            ...(Number.isFinite(Number(o.x)) && o.x != null ? { x: num(o.x, 0, 1, 0.1) } : {}), ...(Number.isFinite(Number(o.y)) && o.y != null ? { y: num(o.y, 0, 1, 0.1) } : {}),
            ...(Number.isFinite(Number(o.w)) && o.w != null ? { w: num(o.w, 0.05, 1, 0.8) } : {}), ...(normalizeHex(o.color) ? { color: normalizeHex(o.color)! } : {}),
            ...(Number.isFinite(Number(o.fontSizePct)) && o.fontSizePct != null ? { fontSizePct: num(o.fontSizePct, DESIGN_LIMITS.minFontPct, DESIGN_LIMITS.maxFontPct, 0.03) } : {}),
            ...(typeof o.bold === 'boolean' ? { bold: o.bold } : {}),
            ...(normalizeHex(o.boxFill) ? { boxFill: normalizeHex(o.boxFill) } : {}),
            ...(o.boxOpacity != null && Number.isFinite(Number(o.boxOpacity)) ? { boxOpacity: num(o.boxOpacity, 0, 1, 1) } : {}),
        });
    }
    const any = card.pageColor || card.photoOpacity !== undefined || card.font || card.changes.length || card.add.length;
    return any ? card : null;
}

/**
 * Layers whose words only ever come from what the business recorded: a chat change may move or recolour them, never
 * reword them or take them off (a model inventing a phone number or an offer). The user can still type them in the editor.
 */
export const CHAT_LOCKED_ROLES = ['contact', 'offer'] as const;

/** The change applied. A layer named that is not on the design is left out; `applied` says how many landed. */
export function applyDesignEdit(design: Design, card: Pick<DesignEditCard, 'pageColor' | 'photoOpacity' | 'font' | 'changes' | 'add'>, opts: { fromChat?: boolean } = {}): { design: Design; applied: number } {
    let applied = 0;
    const next: Design = { ...design, layers: design.layers.map((l) => ({ ...l })) };
    if (card.pageColor) { next.pageColor = card.pageColor; applied++; }
    if (card.photoOpacity !== undefined && next.photo) { next.photo = { ...next.photo, opacity: card.photoOpacity }; applied++; }
    if (card.font) {
        next.layers = next.layers.map((l) => (l.kind === 'text' ? { ...l, fontFamily: card.font! } : l));
        applied++;
    }
    for (let c of card.changes) {
        const at = next.layers.findIndex((l) => l.id === c.layer || l.role === c.layer);
        if (at < 0) continue;
        const l = next.layers[at];
        const locked = !!opts.fromChat && (CHAT_LOCKED_ROLES as readonly string[]).includes(l.role);
        if (c.remove) { if (locked) continue; applied++; next.layers.splice(at, 1); continue; }
        if (locked && c.text !== undefined) {
            const { text: _text, ...rest } = c;
            if (Object.keys(rest).length <= 1) continue;   // only the words were asked for
            c = rest;
        }
        applied++;
        const pos = { ...(c.x !== undefined ? { x: c.x } : {}), ...(c.y !== undefined ? { y: c.y } : {}), ...(c.w !== undefined ? { w: c.w } : {}) };
        if (l.kind === 'text') {
            const { layer: _layer, remove: _remove, ...rest } = c;
            next.layers[at] = { ...l, ...rest } as TextLayer;
        } else next.layers[at] = { ...l, ...pos };
    }
    for (const a of card.add) {
        if (next.layers.length >= DESIGN_LIMITS.layers) break;
        applied++;
        next.layers.push(textLayer({ ...a, role: 'text' }, `chat${next.layers.length}-${applied}`, undefined));
    }
    return { design: next, applied };
}

/** The design as a few words per layer, for the chat's list of briefs. */
export function designForChat(design: Design): string {
    const layers = design.layers.map((l) => (l.kind === 'text'
        ? `${l.role === 'text' ? l.id : l.role} "${l.text.replace(/\s+/g, ' ').slice(0, 60)}" (${l.color}${l.boxFill ? `, background ${l.boxFill} at ${Math.round(l.boxOpacity * 100)}%` : ''}${l.fontFamily ? `, ${l.fontFamily}` : ''})`
        : l.role));
    return `page colour ${design.pageColor}${design.photo ? `, picture at ${Math.round(design.photo.opacity * 100)}% strength` : ', no picture'}; layers: ${layers.join('; ') || 'none'}`;
}
