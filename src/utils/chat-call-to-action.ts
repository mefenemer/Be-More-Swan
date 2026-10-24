// src/utils/chat-call-to-action.ts
// A Social, Blog or Email assistant's chat: what its work invites people to do, and the
// call_to_action card that changes it (src/config/call-to-action.ts). Same contract as every chat
// card — the model only proposes; the card is rebuilt against the workspace's real forms; the click
// calls org-products.ts PATCH { callToAction }, the action behind Products & Services ▸ Calls to action.

import type { getDb } from '../../db/client';
import { cleanCtaKind, CTA_LABELS, CTA_ROLES, describeCta, type CtaKind } from '../config/call-to-action';
import { loadCtaForAssistant } from './call-to-action';
import { listGiftForms, type GiftForm } from './outreach-offer';

type Db = ReturnType<typeof getDb>;

export const CTA_CARD_TYPE = 'call_to_action';

export function roleHasCta(roleKey: string | null | undefined): boolean {
    return (CTA_ROLES as readonly string[]).includes(roleKey ?? '');
}

/** The block in a content assistant's chat prompt. Pure. */
export function renderCtaChatBlock(current: string, forms: GiftForm[], unusable?: string | null): string {
    const formLines = forms.length
        ? forms.map((f) => `  • formId ${f.id}: "${f.name}" — free download "${f.giftLabel}"`).join('\n')
        : '  (none yet — a free download is added to a sign-up form in Audience ▸ Sign-up forms)';
    return `YOUR CALL TO ACTION — what your work invites people to do: ${current}.${unusable ? ` (${unusable})` : ''} Set on Business Information ▸ Products & Services ▸ Calls to action.
Sign-up forms with a free download:
${formLines}
To change it, put this in "uiElement" (one per reply) — only when the user asks:
{ "type": "call_to_action", "summary": "<one sentence>", "kind": "own" | "intro_offer" | "gift", "formId": <a formId above, for a gift; else null> }
"own" = the call to action in your own brief; "intro_offer" = the free trial or introductory offer on Products & Services. The user confirms on the card and only that click saves it — never say it HAS changed.`;
}

/** The block for this assistant, loaded — null for a role without a call to action, or on failure. */
export async function buildCtaChatBlock(db: Db, organisationId: number, assistantId: number, roleKey: string | null | undefined): Promise<string | null> {
    if (!roleHasCta(roleKey)) return null;
    try {
        const [cta, forms] = await Promise.all([loadCtaForAssistant(db, organisationId, assistantId), listGiftForms(db, organisationId)]);
        return renderCtaChatBlock(describeCta(cta), forms, cta.kind === 'own' ? cta.unusable : null);
    } catch {
        return null;
    }
}

export interface CtaCard {
    type: typeof CTA_CARD_TYPE;
    summary: string | null;
    kind: CtaKind;
    kindLabel: string;
    formId: number | null;
    formName: string | null;
    giftLabel: string | null;
}

/** Shape check, then rebuilt against the real forms. Null = not this card; { error } = refused. Pure. */
export function ctaCardFrom(ui: unknown, forms: GiftForm[]): CtaCard | { error: string } | null {
    if (!ui || typeof ui !== 'object' || (ui as { type?: unknown }).type !== CTA_CARD_TYPE) return null;
    const u = ui as { summary?: unknown; kind?: unknown; formId?: unknown };
    const kind = cleanCtaKind(u.kind);
    if (!kind) return { error: 'I couldn’t tell which call to action you meant.' };
    const summary = typeof u.summary === 'string' ? u.summary.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
    if (kind !== 'gift') return { type: CTA_CARD_TYPE, summary, kind, kindLabel: CTA_LABELS[kind], formId: null, formName: null, giftLabel: null };
    const form = forms.find((f) => f.id === Number(u.formId)) ?? (u.formId == null ? forms[0] : undefined);
    if (!form) {
        return { error: forms.length
            ? 'That isn’t one of your sign-up forms with a free download.'
            : 'None of your sign-up forms sends a free download yet — add one in Audience ▸ Sign-up forms ▸ Free download first.' };
    }
    return { type: CTA_CARD_TYPE, summary, kind, kindLabel: CTA_LABELS.gift, formId: form.id, formName: form.name, giftLabel: form.giftLabel };
}
