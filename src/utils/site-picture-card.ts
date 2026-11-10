// src/utils/site-picture-card.ts — the Website Assistant's site_picture card, tidied before it is stored.
//
// FR#9 / issue 34 (org 41, 2026-11-10): asked for pictures on several sections at once, the assistant
// could only send ONE picture card per reply, promised the rest, and the replies that followed came
// without the cards they mentioned. A card may now carry `sections` — one picker per section, each
// working on its own in the chat (disruptive-ui-registry.js renderSitePictureCard). Pure.

export const SITE_PICTURE_TYPE = 'site_picture';
/** Most sections on one card: each one is a search or an AI run the owner works through by hand. */
export const MAX_PICTURE_SECTIONS = 6;

export interface SitePictureSection {
    pageId: string;
    sectionId: string;
    sectionLabel: string;
    place: 'in' | 'after';
    description: string;
    alt: string;
}

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

function section(v: unknown): SitePictureSection | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const pageId = str(o.pageId, 80);
    const sectionId = str(o.sectionId, 80);
    if (!pageId || !sectionId) return null;
    return {
        pageId, sectionId,
        sectionLabel: str(o.sectionLabel, 120),
        place: o.place === 'after' ? 'after' : 'in',
        description: str(o.description, 600),
        alt: str(o.alt, 150),
    };
}

/**
 * A site_picture card with its sections checked: the top-level section and any in `sections`, deduped
 * by page + section, capped at MAX_PICTURE_SECTIONS. One section → the plain one-section card, exactly
 * as before; several → the first at the top level (so an older page still draws something) plus
 * `sections` holding all of them. Anything else is returned untouched; null when no section is usable.
 */
export function normaliseSitePictureCard(ui: unknown): Record<string, unknown> | null {
    if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null;
    const o = ui as Record<string, unknown>;
    if (o.type !== SITE_PICTURE_TYPE) return o;
    const all = [section(o), ...(Array.isArray(o.sections) ? o.sections.map(section) : [])];
    const seen = new Set<string>();
    const list: SitePictureSection[] = [];
    for (const s of all) {
        if (!s) continue;
        const key = `${s.pageId}\u0000${s.sectionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(s);
        if (list.length >= MAX_PICTURE_SECTIONS) break;
    }
    if (!list.length) return null;
    const kind = o.kind === 'video' ? 'video' : 'picture';
    const source = o.source === 'stock' ? 'stock' : o.source === 'library' ? 'library' : 'ai';
    const base = { type: SITE_PICTURE_TYPE, kind, source, ...list[0] };
    return list.length === 1 ? base : { ...base, sections: list };
}
