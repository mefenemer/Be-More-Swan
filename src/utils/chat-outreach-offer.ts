// src/utils/chat-outreach-offer.ts
// The Lead Generator's chat: what its outreach offers right now, and the outreach_offer card that
// changes it (src/config/outreach-offer.ts). Same contract as every other chat card — the model only
// proposes; the card is rebuilt from the workspace's real forms; the click calls lead-generation.ts
// `set_outreach_offer`, the action behind the Outreach tab's offer strip. Never throws.

import type { getDb } from '../../db/client';
import { cleanOutreachOfferKind, describeOutreachOffer, OUTREACH_OFFER_LABELS, type OutreachOfferKind } from '../config/outreach-offer';
import { listGiftForms, loadOutreachOffer, type GiftForm } from './outreach-offer';

type Db = ReturnType<typeof getDb>;

export const OUTREACH_OFFER_CARD_TYPE = 'outreach_offer';

/** The block in the Lead Generator's chat prompt. Pure. */
export function renderOutreachOfferChatBlock(current: string, forms: GiftForm[], unusable?: string | null): string {
    const formLines = forms.length
        ? forms.map((f) => `  • formId ${f.id}: "${f.name}" — free download "${f.giftLabel}"${f.linkable ? '' : ' (no page of its own yet, so follow-ups cannot link to it)'}`).join('\n')
        : '  (none — a gift needs a sign-up form with a free download, made with the Email Marketing Assistant or in Audience ▸ Sign-up forms)';
    return `YOUR OUTREACH OFFER — what your first emails offer: ${current}.${unusable ? ` (${unusable})` : ''}
Every first email is under 75 words, opens with the prospect's problem, carries no link, never asks for a call and ends by asking permission. The first follow-up carries the link; for a gift it is tracked, so a sign-up through it is credited to the lead and stops the follow-ups. The owner sees and changes this on the Outreach tab.
Gift forms in this workspace:
${formLines}
To change it, put this in "uiElement" (one per reply) — only when the user asks:
{ "type": "outreach_offer", "summary": "<one sentence>", "offer": "gift" | "intro_offer" | "reply", "formId": <a formId above, for a gift; else null> }
"intro_offer" uses the free trial or introductory offer saved in Business Information ▸ Products & Services. The user confirms on the card and only that click saves it — never say it HAS changed.`;
}

/** The block for this assistant, loaded. Null on failure. */
export async function buildOutreachOfferChatBlock(db: Db, organisationId: number, assistantId: number): Promise<string | null> {
    try {
        const [offer, forms] = await Promise.all([loadOutreachOffer(db, organisationId, assistantId), listGiftForms(db, organisationId)]);
        return renderOutreachOfferChatBlock(describeOutreachOffer(offer), forms, offer.kind === 'reply' ? offer.unusable : null);
    } catch {
        return null;
    }
}

export interface OutreachOfferCard {
    type: typeof OUTREACH_OFFER_CARD_TYPE;
    summary: string | null;
    offer: OutreachOfferKind;
    offerLabel: string;
    formId: number | null;
    /** For a gift: what the card shows. */
    formName: string | null;
    giftLabel: string | null;
}

/** Shape check, then rebuilt against the real forms. Null = not this card; { error } = refused. Pure. */
export function outreachOfferCardFrom(ui: unknown, forms: GiftForm[]): OutreachOfferCard | { error: string } | null {
    if (!ui || typeof ui !== 'object' || (ui as { type?: unknown }).type !== OUTREACH_OFFER_CARD_TYPE) return null;
    const u = ui as { summary?: unknown; offer?: unknown; formId?: unknown };
    const offer = cleanOutreachOfferKind(u.offer);
    if (!offer) return { error: 'I couldn’t tell which offer you meant.' };
    const summary = typeof u.summary === 'string' ? u.summary.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
    if (offer !== 'gift') return { type: OUTREACH_OFFER_CARD_TYPE, summary, offer, offerLabel: OUTREACH_OFFER_LABELS[offer], formId: null, formName: null, giftLabel: null };
    const form = forms.find((f) => f.id === Number(u.formId)) ?? (u.formId == null ? forms[0] : undefined);
    if (!form) {
        return { error: forms.length
            ? 'That isn’t one of your sign-up forms with a free download.'
            : 'None of your sign-up forms sends a free download yet — add one in Audience ▸ Sign-up forms ▸ Free download first.' };
    }
    return { type: OUTREACH_OFFER_CARD_TYPE, summary, offer, offerLabel: OUTREACH_OFFER_LABELS.gift, formId: form.id, formName: form.name, giftLabel: form.giftLabel };
}
