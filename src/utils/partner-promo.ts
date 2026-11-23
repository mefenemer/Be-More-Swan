// src/utils/partner-promo.ts
// The partner assistant's drafts (netlify/functions/partner-assistant.ts) — docs/affiliate-partner-programme-plan.md §4.7.
//
// Every draft a partner is given must, whatever the model wrote:
//   1. carry their invite link (or their partner code) — otherwise it earns them nothing;
//   2. be labelled as an ad AT THE START. A partner is paid when someone joins through them, so the
//      UK CAP Code (ASA), the DMCCA 2024 and the US FTC Endorsement Guides all require it to be clear
//      before anyone engages — a label at the end hides behind LinkedIn's "see more" (legal review
//      2026-10-23, H2). A label only further down doesn't count, so one is added at the top.
// So the model hands drafts to deliver_draft, and this module adds whatever is missing. Hand-offs to
// the partner's own assistants carry the same rules in the brief (handoffBrief). Pure.

export type DraftChannel = 'linkedin' | 'social' | 'email' | 'video_script' | 'dm' | 'other';
export const DRAFT_CHANNELS: DraftChannel[] = ['linkedin', 'social', 'email', 'video_script', 'dm', 'other'];

// "affiliate link" alone is not a full disclosure (Partner Terms 5.1: "#affiliate"/"#partner" alone are not enough) — legal review M5.
const DISCLOSURE_RE = /(^|[\s(\[])#ad\b|\bAd:|\(ad\)|\bI earn (a )?commission\b|\bpaid partnership\b/i;

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

/** The label a draft opens with, by channel. */
export const AD_LABELS: Record<'post' | 'message' | 'video', string> = {
    post: '#ad — I earn a commission if you join through my link.',
    message: 'Ad: I’m a Be More Swan partner, so I earn a commission if you join through my link (at no extra cost to you).',
    video: '[Say and show on screen: “This is a paid partnership — I earn a commission if you join through my link.”]',
};
const labelFor = (channel: DraftChannel) =>
    channel === 'email' || channel === 'dm' ? AD_LABELS.message : channel === 'video_script' ? AD_LABELS.video : AD_LABELS.post;

const SUBJECT_RE = /^\s*subject\s*:[^\n]*\n/i;

/** Is the ad label where people see it first — the opening two lines (after an email's subject line)? */
export function hasUpfrontDisclosure(text: string): boolean {
    const body = text.replace(SUBJECT_RE, '');
    const opening = body.split('\n').filter((l) => l.trim()).slice(0, 2).join('\n');
    return hasDisclosure(opening) || SUBJECT_RE.test(text) && hasDisclosure(text.match(SUBJECT_RE)![0]);
}

/** The draft as the partner will see it: link and an up-front ad label guaranteed. */
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
    if (!hasUpfrontDisclosure(text)) {
        const label = labelFor(channel);
        const subject = text.match(SUBJECT_RE)?.[0];
        text = subject ? `${subject}\n${label}\n\n${text.slice(subject.length).trim()}` : `${label}\n\n${text}`;
        addedDisclosure = true;
    }
    return { text, addedLink, addedDisclosure };
}

// No Lead Generator hand-off (legal review 2026-11-23, H1): Partner Terms 5.3(d) bans using contacts it finds to
// promote Be More Swan in ANY way, and our own tool prompting it would be "instigating" unsolicited marketing (PECR
// reg 22) / "procuring" it (CAN-SPAM).
export type HandoffTarget = 'social_media_manager' | 'newsletter_editor';

/**
 * The brief typed into one of the partner's own assistants. Those assistants don't run
 * finaliseDraft, so the rules travel with the brief: posts and emails open with the ad label and
 * keep the link; emails go only to subscribers who opted in to hear from them (PECR / CAN-SPAM).
 * There is deliberately no Lead Generator brief — see HandoffTarget.
 */
export function handoffBrief(target: HandoffTarget, brief: string, ctx: DraftContext): string {
    const link = ctx.inviteUrl ? ` Include my partner link: ${ctx.inviteUrl}${ctx.partnerCode ? ` (or code ${ctx.partnerCode})` : ''}.` : '';
    const rules = target === 'social_media_manager'
        ? `This is a paid promotion of Be More Swan. Start every post with “${AD_LABELS.post}” — the label must come first, not at the end.${link}`
        : `This is a paid promotion of Be More Swan. Put “${AD_LABELS.message}” at the top of the email, before anything else.${link} Send it only to my own subscribers who agreed to hear from me — not people on my list only because they bought from me (the soft opt-in doesn't cover this).`;
    return `${brief.trim()}\n\n${rules}`;
}
