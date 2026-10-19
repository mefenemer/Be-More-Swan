// src/utils/partner-promo.ts
// The partner assistant's drafts (netlify/functions/partner-assistant.ts) — docs/affiliate-partner-programme-plan.md §4.7.
//
// Every draft a partner is given must, whatever the model wrote:
//   1. carry their invite link (or their partner code) — otherwise it earns them nothing;
//   2. be labelled as an ad. A partner is paid when someone joins through them, so under the UK
//      advertising code (CAP Code / ASA, "obviously identifiable" marketing) the post must say so.
// So the model hands drafts to deliver_draft, and this module adds whatever is missing. Pure.

export type DraftChannel = 'linkedin' | 'social' | 'email' | 'video_script' | 'dm' | 'other';
export const DRAFT_CHANNELS: DraftChannel[] = ['linkedin', 'social', 'email', 'video_script', 'dm', 'other'];

const DISCLOSURE_RE = /(^|[\s(\[])#ad\b|\bAd:|\(ad\)|\baffiliate link\b|\bI earn (a )?commission\b|\bpaid partnership\b/i;

export interface DraftContext { inviteUrl: string | null; partnerCode: string | null }

/** Does the text already say it is an ad / affiliate content? */
export function hasDisclosure(text: string): boolean {
    return DISCLOSURE_RE.test(text);
}

/** Does the text already carry the partner's link or code? */
export function hasPartnerLink(text: string, ctx: DraftContext): boolean {
    const t = text.toLowerCase();
    return (!!ctx.inviteUrl && t.includes(ctx.inviteUrl.toLowerCase().replace(/^https?:\/\//, '')))
        || (!!ctx.partnerCode && new RegExp(`\\b${ctx.partnerCode.toLowerCase()}\\b`).test(t));
}

/** The draft as the partner will see it: link and disclosure guaranteed. */
export function finaliseDraft(channel: DraftChannel, rawText: string, ctx: DraftContext): { text: string; addedLink: boolean; addedDisclosure: boolean } {
    let text = String(rawText || '').trim().slice(0, 6000);
    let addedLink = false;
    let addedDisclosure = false;
    if (!hasPartnerLink(text, ctx) && ctx.inviteUrl) {
        text += channel === 'video_script'
            ? `\n\n[On screen / in the description: ${ctx.inviteUrl}]`
            : `\n\n${ctx.inviteUrl}${ctx.partnerCode ? ` (or use code ${ctx.partnerCode})` : ''}`;
        addedLink = true;
    }
    if (!hasDisclosure(text)) {
        const line = channel === 'email' || channel === 'dm'
            ? 'P.S. That’s my partner link — I earn a commission if you join through it, at no extra cost to you.'
            : channel === 'video_script'
                ? '[Say or show: “This is a paid partnership — I earn a commission if you join through my link.”]'
                : '#ad — I earn a commission if you join through my link.';
        text = channel === 'video_script' ? `${line}\n\n${text}` : `${text}\n\n${line}`;
        addedDisclosure = true;
    }
    return { text, addedLink, addedDisclosure };
}
