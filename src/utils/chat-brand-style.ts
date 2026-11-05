// src/utils/chat-brand-style.ts — the Brand Designer's brand_style_proposal card (owner 2026-11-05): talk through
// the colours and font in chat, then save them with a click. The click sends the fields to brand-kit.ts PATCH, the
// same save as the brand style pop-up and Business Information ▸ Brand Assets, with that action's checks.
//
// Rebuilt here because uiElementJson is stored and re-rendered on every reload: a colour that is not a colour or a
// font name that could not go in a font URL never reaches the card. tests/brand-style-chat.test.ts.

import { cleanFontFamily, normalizeHex } from './brand-kit';

export const BRAND_STYLE_TYPE = 'brand_style_proposal';

export interface BrandStyleCard {
    type: typeof BRAND_STYLE_TYPE; summary: string | null;
    primaryColor?: string; backgroundColor?: string; textColor?: string; fontFamily?: string;
}

const COLOURS = ['primaryColor', 'backgroundColor', 'textColor'] as const;

export function brandStyleFromUiElement(uiElement: unknown): BrandStyleCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== BRAND_STYLE_TYPE) return null;
    const card: BrandStyleCard = { type: BRAND_STYLE_TYPE, summary: typeof ui.summary === 'string' ? ui.summary.trim().slice(0, 300) || null : null };
    let changes = 0;
    for (const f of COLOURS) {
        const hex = normalizeHex(ui[f]);
        if (hex) { card[f] = hex; changes++; }
    }
    const font = cleanFontFamily(ui.fontFamily);
    if (font) { card.fontFamily = font; changes++; }
    return changes ? card : null;
}
