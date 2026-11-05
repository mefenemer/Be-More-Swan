// src/utils/chat-brief-edit.ts — the Brand Designer's visual_brief_edit card (owner 2026-11-05): "more like
// this one, but brighter". A change to what a brief asks for, shown field by field; the click sends it to
// brand-briefs.ts `edit`, the same action as the Briefs tab's Edit button, with that action's checks.
//
// It only saves. Making options is what can cost, and that stays the button on the brief, which states its
// cost before it is pressed: a chat card never spends. A flyer can change here too, until it is finished: its
// words (`flyerWords`) are merged into the saved ones by mergeFlyerWords, so contact details and the QR link,
// which never come from a model, cannot change. A finished flyer takes no more rounds; the prompt gives it a new brief.
// Checked and rebuilt here because uiElementJson is stored and re-rendered on every reload.
// tests/brief-chat-pane.test.ts.

import { MODEL_WRITTEN_FIELDS, normaliseFlyerContent, type FlyerContent } from '../config/flyer-vocab';

export const VISUAL_BRIEF_EDIT_TYPE = 'visual_brief_edit';

export interface BriefEditCard {
    type: typeof VISUAL_BRIEF_EDIT_TYPE; briefId: number; summary: string | null;
    message?: string; mood?: string; mustInclude?: string; mustAvoid?: string;
    /** A flyer: the whole set of words after the change. Only ever set by mergeFlyerWords. */
    flyerContent?: FlyerContent;
}

/** The same rule as drafted words (flyer-words.ts): contact details are never written by a model. */
const CONTACTISH = /(\+?\d[\d\s()-]{6,}\d)|(@[a-z0-9-]+\.)|(https?:\/\/)|(www\.)|(\b[a-z0-9-]+\.(co\.uk|com|org|uk|net|io)\b)/i;

/** A flyer's saved words with the model's change on top: only the fields it may write, and no contact details. Null if nothing valid changes. */
export function mergeFlyerWords(saved: unknown, words: unknown): FlyerContent | null {
    if (!words || typeof words !== 'object') return null;
    const w = words as Record<string, unknown>;
    const base = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
    const next: Record<string, unknown> = { ...base };
    let changed = false;
    const ok = (v: unknown) => typeof v === 'string' && !!v.trim() && !CONTACTISH.test(v);
    for (const f of [...MODEL_WRITTEN_FIELDS, 'dateLine'] as const) {
        const v = w[f];
        if (f === 'points') {
            const pts = Array.isArray(v) ? v.filter(ok) : null;
            if (pts && pts.length) { next.points = pts; changed = true; }
        } else if (ok(v)) { next[f] = v; changed = true; }
    }
    if (!changed) return null;
    const n = normaliseFlyerContent(next);
    return n.ok ? n.content : null;
}

const FIELDS = ['message', 'mood', 'mustInclude', 'mustAvoid'] as const;
const MAX_FIELD_CHARS = 1000;

export function briefEditFromUiElement(uiElement: unknown): BriefEditCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== VISUAL_BRIEF_EDIT_TYPE) return null;
    const briefId = Number(String(ui.briefId ?? '').replace(/^#/, ''));
    if (!Number.isInteger(briefId) || briefId <= 0) return null;
    const card: BriefEditCard = { type: VISUAL_BRIEF_EDIT_TYPE, briefId, summary: typeof ui.summary === 'string' ? ui.summary.trim().slice(0, 300) || null : null };
    let changes = 0;
    for (const f of FIELDS) {
        const v = typeof ui[f] === 'string' ? (ui[f] as string).trim().slice(0, MAX_FIELD_CHARS) : '';
        if (v) { card[f] = v; changes++; }
    }
    // Words for a flyer are checked and merged by the orchestrator, which holds the saved ones (mergeFlyerWords).
    return changes || (ui.flyerWords && typeof ui.flyerWords === 'object') ? card : null;
}
