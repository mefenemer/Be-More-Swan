// src/utils/design-doc.ts — a design you can edit: the Brand Designer's studio works on this (owner 2026-11-05: preview
// on the left, chat on the right, change anything on it, "very much like in Canva").
//
// A design is a page colour, a main picture at the back, and layers on top (words, shapes, more pictures, a QR code or
// logo), every position a fraction of the trimmed page and every type size a fraction of its height. The browser (design-studio.js) and the renderer (src/lib/design-render.ts) use
// the same numbers, so what is dragged on screen is what prints.
//
// Pure: no DB, no renderer. Everything a browser or a chat card sends comes through here, so a colour is a colour, a
// font name can go in a font URL, and a picture or QR code can only ever be one the server put there.

import { cleanFontFamily, normalizeHex } from './brand-kit';

export const DESIGN_LIMITS = { layers: 40, pictures: 6, shelf: 12, text: 600, minFontPct: 0.006, maxFontPct: 0.3, minLineHeight: 0.8, maxLineHeight: 3, maxZoom: 5 } as const;
/** Padding of a text box with a background, as a share of its type size. Shared with design-studio.js. */
export const BOX_PAD_RATIO = 0.35;
export const LINE_HEIGHT = 1.25;

/** Where the picture lives. Only ever written by the server. */
export interface DesignPhotoRef {
    source?: string; storageKey: string | null; externalUrl: string | null; mimeType: string;
    width: number | null; height: number | null; attributionName?: string | null; attributionUrl?: string | null;
}

/**
 * How a picture sits in its frame. It always covers the frame; `zoom` 1 is just covering, and x and y (0 to 1) say which
 * part shows: 0 the left or top of the picture, 1 the right or bottom. No crop means zoom 1, centred.
 */
export interface DesignCrop { zoom: number; x: number; y: number }

export interface DesignPhoto { x: number; y: number; w: number; h: number; opacity: number; ref: DesignPhotoRef; crop?: DesignCrop }

export interface TextLayer {
    id: string; kind: 'text'; role: string; text: string;
    x: number; y: number; w: number;
    fontFamily: string | null; fontSizePct: number; bold: boolean; align: 'left' | 'center' | 'right';
    color: string; boxFill: string | null; boxOpacity: number;
    /** Missing on a design from before 2026-11-06: upright, not underlined, LINE_HEIGHT. */
    italic?: boolean; underline?: boolean; lineHeight?: number;
}
export interface ShapeLayer { id: string; kind: 'shape'; role: string; x: number; y: number; w: number; h: number; color: string; round: boolean; opacity: number }
/** A QR code or logo: `src` is set by the server when the design is made, and never taken from a browser. */
export interface ImageLayer { id: string; kind: 'qr' | 'logo'; role: string; x: number; y: number; w: number; h: number; src: string }
/** A picture added on top of the page. `ref` is set by the server from the workspace's own library, like the main picture's. */
export interface PictureLayer { id: string; kind: 'picture'; role: string; x: number; y: number; w: number; h: number; opacity: number; ref: DesignPhotoRef; crop?: DesignCrop }
export type DesignLayer = TextLayer | ShapeLayer | ImageLayer | PictureLayer;
/** The layers that point at a file: only ever made by the server, so what was taken off is kept to put back. */
export type HeldLayer = ImageLayer | PictureLayer;

export interface Design {
    v: 1;
    kind: 'flyer' | 'image';
    /** The page in millimetres (flyer) or pixels (image): only the shape matters here. */
    pageW: number; pageH: number;
    paperSize: string | null;
    pageColor: string;
    /** 1 is solid, 0 is bare paper. Missing on a design from before 2026-11-06, which is solid. */
    pageOpacity?: number;
    photo: DesignPhoto | null;
    layers: DesignLayer[];
    /**
     * What was taken off, and a QR code or logo the design could have: Undo and "put back" only work because the server
     * still holds these, as a browser can never name a file itself. Written by the server; a browser's copy is ignored.
     */
    removed?: { layers: HeldLayer[]; photo: DesignPhoto | null };
}

const num = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r/g, '').slice(0, max) : '');
const ALIGN = ['left', 'center', 'right'] as const;
const align = (v: unknown, fallback: TextLayer['align']): TextLayer['align'] => (ALIGN as readonly unknown[]).includes(v) ? v as TextLayer['align'] : fallback;
const cleanId = (v: unknown, fallback: string): string => { const s = String(v ?? ''); return /^[\w-]{1,40}$/.test(s) ? s : fallback; };
const isHeld = (l: DesignLayer): l is HeldLayer => l.kind === 'qr' || l.kind === 'logo' || l.kind === 'picture';

/** A crop made safe. Null for one that changes nothing, so an untouched picture stays exactly as it was. */
export function cleanCrop(v: unknown): DesignCrop | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const c = v as Record<string, unknown>;
    const crop = { zoom: num(c.zoom, 1, DESIGN_LIMITS.maxZoom, 1), x: num(c.x, 0, 1, 0.5), y: num(c.y, 0, 1, 0.5) };
    return crop.zoom === 1 && crop.x === 0.5 && crop.y === 0.5 ? undefined : crop;
}

/** Where a picture of `iw` × `ih` is drawn in a frame of `bw` × `bh`: the one sum the screen and the print share. */
export function cropRect(iw: number, ih: number, bw: number, bh: number, crop?: DesignCrop | null): { left: number; top: number; width: number; height: number } {
    const c = crop ?? { zoom: 1, x: 0.5, y: 0.5 };
    const scale = Math.max(bw / iw, bh / ih) * c.zoom;
    const width = iw * scale;
    const height = ih * scale;
    return { left: (bw - width) * c.x, top: (bh - height) * c.y, width, height };
}

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
        italic: raw.italic !== undefined ? !!raw.italic : base?.italic ?? false,
        underline: raw.underline !== undefined ? !!raw.underline : base?.underline ?? false,
        lineHeight: num(raw.lineHeight, DESIGN_LIMITS.minLineHeight, DESIGN_LIMITS.maxLineHeight, base?.lineHeight ?? LINE_HEIGHT),
    };
}

const SHAPE_DEFAULT = { x: 0.3, y: 0.3, w: 0.4, h: 0.2, color: '#1f1e1b', opacity: 1 };

/** A new shape. Nothing in one can point anywhere, so a browser may make them. */
function newShape(l: Record<string, unknown>, id: string): ShapeLayer {
    return {
        id, kind: 'shape', role: l.role === 'line' ? 'line' : l.round === true ? 'circle' : 'shape',
        x: num(l.x, -1, 2, SHAPE_DEFAULT.x), y: num(l.y, -1, 2, SHAPE_DEFAULT.y), w: num(l.w, 0.002, 2, SHAPE_DEFAULT.w), h: num(l.h, 0.002, 2, SHAPE_DEFAULT.h),
        color: normalizeHex(l.color) ?? SHAPE_DEFAULT.color, round: l.round === true, opacity: num(l.opacity, 0, 1, SHAPE_DEFAULT.opacity),
    };
}

const pictureCount = (layers: DesignLayer[]) => layers.filter((l) => l.kind === 'picture').length;

/**
 * The page colour at its strength, on white paper, as a solid colour. Flat on purpose: a PDF prints on white anyway, and
 * a see-through PNG can turn black when a social platform flattens it. Same sum as design-studio.js, so screen = print.
 */
export function pageFill(design: Pick<Design, 'pageColor' | 'pageOpacity'>): string {
    const a = design.pageOpacity ?? 1;
    const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(design.pageColor);
    if (!m || a >= 1) return design.pageColor;
    return `#${[m[1], m[2], m[3]].map((h) => Math.round(parseInt(h, 16) * a + 255 * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * What a browser sent, made safe, on top of what is stored. The picture's location and any QR or logo image can only
 * come from `stored`: a browser may move them or remove them, never point them somewhere else.
 */
export function normaliseDesign(raw: unknown, stored: Design): Design {
    const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const shelf = stored.removed?.layers ?? [];
    const storedById = new Map<string, DesignLayer>([...shelf, ...stored.layers].map((l) => [l.id, l]));
    const photoSource = stored.photo ?? stored.removed?.photo ?? null;
    const seen = new Set<string>();
    const layers: DesignLayer[] = [];
    for (const item of Array.isArray(r.layers) ? r.layers : []) {
        if (!item || typeof item !== 'object' || layers.length >= DESIGN_LIMITS.layers) continue;
        const l = item as Record<string, unknown>;
        const id = cleanId(l.id, `t${layers.length}`);
        if (seen.has(id)) continue;
        seen.add(id);
        const was = storedById.get(id);
        // A duplicate names what it copies: its file can only be one the server already holds.
        const copied = !was && typeof l.copyOf === 'string' ? storedById.get(l.copyOf) : undefined;
        const held = was ?? copied;
        if (l.kind === 'text') layers.push(textLayer(l, id, was?.kind === 'text' ? was : undefined));
        else if (l.kind === 'shape') {
            if (was?.kind === 'shape') layers.push({ ...was, x: num(l.x, -1, 2, was.x), y: num(l.y, -1, 2, was.y), w: num(l.w, 0.002, 2, was.w), h: num(l.h, 0.002, 2, was.h), color: normalizeHex(l.color) ?? was.color, opacity: num(l.opacity, 0, 1, was.opacity) });
            else layers.push(newShape(l, id));
        } else if ((l.kind === 'qr' || l.kind === 'logo') && held && held.kind === l.kind) {
            layers.push({ ...held, id, x: num(l.x, -0.5, 1.5, held.x), y: num(l.y, -0.5, 1.5, held.y), w: num(l.w, 0.02, 1.5, held.w), h: num(l.h, 0.02, 1.5, held.h) });
        } else if (l.kind === 'picture' && pictureCount(layers) < DESIGN_LIMITS.pictures) {
            const from = held?.kind === 'picture' ? held : !was && l.copyOf === 'photo' ? photoSource : null;
            if (from) {
                const crop = cleanCrop(l.crop);
                layers.push({
                    id, kind: 'picture', role: 'picture', ref: from.ref,
                    x: num(l.x, -1, 2, from.x), y: num(l.y, -1, 2, from.y), w: num(l.w, 0.02, 3, from.w), h: num(l.h, 0.02, 3, from.h),
                    opacity: num(l.opacity, 0, 1, from.opacity), ...(crop ? { crop } : {}),
                });
            }
        }
    }
    const kept = new Set(layers.map((l) => l.id));
    const taken = [...shelf, ...stored.layers.filter(isHeld)].filter((l, i, all) => !kept.has(l.id) && all.findIndex((x) => x.id === l.id) === i);
    const p = r.photo && typeof r.photo === 'object' ? r.photo as Record<string, unknown> : null;
    const photoCrop = p ? cleanCrop(p.crop) : undefined;
    return {
        ...stored,
        pageColor: normalizeHex(r.pageColor) ?? stored.pageColor,
        pageOpacity: num(r.pageOpacity, 0, 1, stored.pageOpacity ?? 1),
        photo: photoSource && p ? {
            ref: photoSource.ref,
            x: num(p.x, -1, 2, photoSource.x), y: num(p.y, -1, 2, photoSource.y),
            w: num(p.w, 0.02, 3, photoSource.w), h: num(p.h, 0.02, 3, photoSource.h),
            opacity: num(p.opacity, 0, 1, photoSource.opacity),
            ...(photoCrop ? { crop: photoCrop } : {}),
        } : null,
        layers,
        removed: { layers: taken.slice(-DESIGN_LIMITS.shelf), photo: p ? null : photoSource },
    };
}

// ── A change from the chat ──────────────────────────────────────────────────────────────────────

export const DESIGN_EDIT_TYPE = 'design_edit';

export interface DesignLayerChange {
    /** A layer's id, or its role: headline, subheading, points, offer, callToAction, dateLine, contact, wordmark. */
    layer: string;
    text?: string; color?: string; fontFamily?: string; fontSizePct?: number; bold?: boolean;
    italic?: boolean; underline?: boolean; lineHeight?: number;
    align?: TextLayer['align']; boxFill?: string | null; boxOpacity?: number;
    x?: number; y?: number; w?: number; h?: number; opacity?: number; crop?: DesignCrop | null; remove?: boolean;
    order?: DesignOrder; duplicate?: boolean;
}
/** A layer's place in the stack. The main picture is always at the back, behind every layer. */
export const DESIGN_ORDERS = ['front', 'forward', 'backward', 'back'] as const;
export type DesignOrder = typeof DESIGN_ORDERS[number];
export interface DesignShapeAdd { shape: 'rectangle' | 'circle' | 'line'; x?: number; y?: number; w?: number; h?: number; color?: string; opacity?: number }
export interface DesignEditCard {
    type: typeof DESIGN_EDIT_TYPE; briefId: number; optionId: number; summary: string | null;
    pageColor?: string; pageOpacity?: number; photoOpacity?: number; photoCrop?: DesignCrop | null; font?: string;
    /** Take these back off the shelf: "qr", "logo", "photo", or a picture layer's id. */
    putBack?: string[];
    shapes?: DesignShapeAdd[];
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
    if (ui.pageOpacity != null && Number.isFinite(Number(ui.pageOpacity))) card.pageOpacity = num(ui.pageOpacity, 0, 1, 1);
    if (ui.photoOpacity !== undefined && Number.isFinite(Number(ui.photoOpacity))) card.photoOpacity = num(ui.photoOpacity, 0, 1, 1);
    if (ui.photoCrop !== undefined) card.photoCrop = cleanCrop(ui.photoCrop) ?? null;
    const font = cleanFontFamily(ui.font);
    if (font) card.font = font;
    const putBack = (Array.isArray(ui.putBack) ? ui.putBack : []).map((v) => cleanId(v, '')).filter(Boolean).slice(0, DESIGN_LIMITS.shelf);
    if (putBack.length) card.putBack = putBack;
    const shapes: DesignShapeAdd[] = [];
    for (const s of (Array.isArray(ui.shapes) ? ui.shapes : []).slice(0, 5)) {
        if (!s || typeof s !== 'object') continue;
        const o = s as Record<string, unknown>;
        if (o.shape !== 'rectangle' && o.shape !== 'circle' && o.shape !== 'line') continue;
        const out: DesignShapeAdd = { shape: o.shape };
        for (const k of ['x', 'y', 'w', 'h'] as const) if (o[k] != null && Number.isFinite(Number(o[k]))) out[k] = num(o[k], k === 'x' || k === 'y' ? -0.5 : 0.002, 1.5, 0.3);
        const color = normalizeHex(o.color); if (color) out.color = color;
        if (o.opacity != null && Number.isFinite(Number(o.opacity))) out.opacity = num(o.opacity, 0, 1, 1);
        shapes.push(out);
    }
    if (shapes.length) card.shapes = shapes;
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
        if (typeof o.italic === 'boolean') out.italic = o.italic;
        if (typeof o.underline === 'boolean') out.underline = o.underline;
        if (o.lineHeight != null && Number.isFinite(Number(o.lineHeight))) out.lineHeight = num(o.lineHeight, DESIGN_LIMITS.minLineHeight, DESIGN_LIMITS.maxLineHeight, LINE_HEIGHT);
        if (o.h != null && Number.isFinite(Number(o.h))) out.h = num(o.h, 0.002, 1.5, 0.2);
        if (o.opacity != null && Number.isFinite(Number(o.opacity))) out.opacity = num(o.opacity, 0, 1, 1);
        if (o.crop !== undefined) out.crop = cleanCrop(o.crop) ?? null;
        if ((DESIGN_ORDERS as readonly unknown[]).includes(o.order)) out.order = o.order as DesignOrder;
        if (o.duplicate === true) out.duplicate = true;
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
    const any = card.pageColor || card.pageOpacity !== undefined || card.photoOpacity !== undefined || card.photoCrop !== undefined || card.putBack || card.shapes || card.font || card.changes.length || card.add.length;
    return any ? card : null;
}

/**
 * Layers whose words only ever come from what the business recorded: a chat change may move or recolour them, never
 * reword them or take them off (a model inventing a phone number or an offer). The user can still type them in the editor.
 */
export const CHAT_LOCKED_ROLES = ['contact', 'offer'] as const;

/** The change applied. A layer named that is not on the design is left out; `applied` says how many landed. */
export function applyDesignEdit(design: Design, card: Pick<DesignEditCard, 'pageColor' | 'pageOpacity' | 'photoOpacity' | 'photoCrop' | 'putBack' | 'shapes' | 'font' | 'changes' | 'add'>, opts: { fromChat?: boolean } = {}): { design: Design; applied: number } {
    let applied = 0;
    const next: Design = { ...design, layers: design.layers.map((l) => ({ ...l })) };
    const shelf: HeldLayer[] = [...(design.removed?.layers ?? [])];
    let shelfPhoto = design.removed?.photo ?? null;
    if (card.pageColor) { next.pageColor = card.pageColor; applied++; }
    if (card.pageOpacity !== undefined) { next.pageOpacity = card.pageOpacity; applied++; }
    for (const wanted of card.putBack ?? []) {
        if (wanted === 'photo') {
            if (!next.photo && shelfPhoto) { next.photo = shelfPhoto; shelfPhoto = null; applied++; }
            continue;
        }
        const at = shelf.findIndex((l) => l.id === wanted || l.role === wanted);
        if (at < 0 || next.layers.length >= DESIGN_LIMITS.layers || (shelf[at].kind === 'picture' && pictureCount(next.layers) >= DESIGN_LIMITS.pictures)) continue;
        next.layers.push(shelf.splice(at, 1)[0]);
        applied++;
    }
    if (card.photoOpacity !== undefined && next.photo) { next.photo = { ...next.photo, opacity: card.photoOpacity }; applied++; }
    if (card.photoCrop !== undefined && next.photo) {
        const { crop: _crop, ...photo } = next.photo;
        next.photo = card.photoCrop ? { ...photo, crop: card.photoCrop } : photo;
        applied++;
    }
    if (card.font) {
        next.layers = next.layers.map((l) => (l.kind === 'text' ? { ...l, fontFamily: card.font! } : l));
        applied++;
    }
    for (let c of card.changes) {
        const at = next.layers.findIndex((l) => l.id === c.layer || l.role === c.layer);
        if (at < 0) continue;
        const l = next.layers[at];
        const locked = !!opts.fromChat && (CHAT_LOCKED_ROLES as readonly string[]).includes(l.role);
        if (c.remove) {
            if (locked) continue;
            applied++;
            next.layers.splice(at, 1);
            if (isHeld(l)) shelf.push(l);
            continue;
        }
        if (locked && c.text !== undefined) {
            const { text: _text, ...rest } = c;
            if (Object.keys(rest).length <= 1) continue;   // only the words were asked for
            c = rest;
        }
        applied++;
        const pos = { ...(c.x !== undefined ? { x: c.x } : {}), ...(c.y !== undefined ? { y: c.y } : {}), ...(c.w !== undefined ? { w: c.w } : {}) };
        const { layer: _layer, remove: _remove, order, duplicate, crop, h, opacity, ...rest } = c;
        if (l.kind === 'text') next.layers[at] = { ...l, ...rest } as TextLayer;
        else if (l.kind === 'shape') next.layers[at] = { ...l, ...pos, ...(h !== undefined ? { h } : {}), ...(opacity !== undefined ? { opacity } : {}), ...(c.color ? { color: c.color } : {}) };
        else if (l.kind === 'picture') {
            const { crop: _old, ...picture } = l;
            next.layers[at] = { ...picture, ...pos, ...(h !== undefined ? { h } : {}), ...(opacity !== undefined ? { opacity } : {}), ...(crop === null ? {} : crop ? { crop } : l.crop ? { crop: l.crop } : {}) };
        } else next.layers[at] = { ...l, ...pos, ...(h !== undefined ? { h } : {}) };
        const changed = next.layers[at];
        if (duplicate && next.layers.length < DESIGN_LIMITS.layers && (changed.kind !== 'picture' || pictureCount(next.layers) < DESIGN_LIMITS.pictures)) {
            next.layers.splice(at + 1, 0, { ...changed, id: `copy${next.layers.length}-${applied}`, x: changed.x + 0.03, y: changed.y + 0.03 });
        }
        if (order) moveLayer(next.layers, changed.id, order);
    }
    for (const s of card.shapes ?? []) {
        if (next.layers.length >= DESIGN_LIMITS.layers) break;
        applied++;
        const defaults = s.shape === 'line' ? { w: 0.6, h: 0.006, x: 0.2, y: 0.5 } : {};
        next.layers.push(newShape({ ...defaults, ...s, role: s.shape === 'line' ? 'line' : undefined, round: s.shape === 'circle' }, `chat${next.layers.length}-${applied}`));
    }
    for (const a of card.add) {
        if (next.layers.length >= DESIGN_LIMITS.layers) break;
        applied++;
        next.layers.push(textLayer({ ...a, role: 'text' }, `chat${next.layers.length}-${applied}`, undefined));
    }
    next.removed = { layers: shelf.slice(-DESIGN_LIMITS.shelf), photo: shelfPhoto };
    return { design: next, applied };
}

/** Move a layer in the stack: the end of the list is the front. */
export function moveLayer(layers: DesignLayer[], id: string, order: DesignOrder): void {
    const at = layers.findIndex((l) => l.id === id);
    if (at < 0) return;
    const [layer] = layers.splice(at, 1);
    const to = order === 'front' ? layers.length : order === 'back' ? 0 : order === 'forward' ? Math.min(layers.length, at + 1) : Math.max(0, at - 1);
    layers.splice(to, 0, layer);
}

/** The design as a few words per layer, for the chat's list of briefs. */
export function designForChat(design: Design): string {
    const layers = design.layers.map((l) => (l.kind === 'text'
        ? `${l.role === 'text' ? l.id : l.role} "${l.text.replace(/\s+/g, ' ').slice(0, 60)}" (${l.color}${l.boxFill ? `, background ${l.boxFill} at ${Math.round(l.boxOpacity * 100)}%` : ''}${l.fontFamily ? `, ${l.fontFamily}` : ''})`
        : `${l.role} (layer "${l.id}"${l.kind === 'shape' ? `, ${l.color}` : ''})`));
    const held = design.removed ? [...design.removed.layers.map((l) => (l.kind === 'picture' ? l.id : l.role)), ...(design.removed.photo ? ['photo'] : [])] : [];
    const page = (design.pageOpacity ?? 1) < 1 ? ` at ${Math.round((design.pageOpacity ?? 1) * 100)}% strength` : '';
    return `page colour ${design.pageColor}${page}${design.photo ? `, picture at ${Math.round(design.photo.opacity * 100)}% strength` : ', no picture'}; layers, back to front: ${layers.join('; ') || 'none'}${held.length ? `; can be put back: ${held.join(', ')}` : ''}`;
}
