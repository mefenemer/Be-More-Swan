// src/utils/chat-brief-edit.ts — the Brand Designer's visual_brief_edit card (owner 2026-11-05): "more like
// this one, but brighter". A change to what a brief asks for, shown field by field; the click sends it to
// brand-briefs.ts `edit`, the same action as the Briefs tab's Edit button, with that action's checks.
//
// It only saves. Making options is what can cost, and that stays the button on the brief, which states its
// cost before it is pressed: a chat card never spends. Flyers are left out, because their words are their own
// form (flyerContent) and a finished one takes no more rounds; the prompt gives them a new brief instead.
// Checked and rebuilt here because uiElementJson is stored and re-rendered on every reload.
// tests/brief-chat-pane.test.ts.

export const VISUAL_BRIEF_EDIT_TYPE = 'visual_brief_edit';

export interface BriefEditCard {
    type: typeof VISUAL_BRIEF_EDIT_TYPE; briefId: number; summary: string | null;
    message?: string; mood?: string; mustInclude?: string; mustAvoid?: string;
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
    return changes ? card : null;
}
