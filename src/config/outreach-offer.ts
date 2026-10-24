// src/config/outreach-offer.ts
// What a Lead Generator's cold emails OFFER, and the rules every outreach prompt follows because of it.
// Pure — the database half (which form, the intro offer, the tracked link) is src/utils/outreach-offer.ts.
//
// Owner, 2026-10-24: start emailing leads with targeted emails that bring them to sign up. Cold emails
// that lead with the product fail; the ones that work lead with the recipient's problem and then offer
// something small and easy to say yes to — a free gift, a trial, or just a question. So each Lead
// Generator chooses ONE offer (onboarding_context.outreachOffer):
//
//   gift         — a free download: one of the workspace's sign-up forms that emails a PDF
//                  (Audience ▸ Sign-up forms ▸ Free download, src/utils/form-reward.ts)
//   intro_offer  — the workspace's free trial / introductory offer (src/utils/intro-offer.ts)
//   reply        — no offer; the email asks one question worth answering (the default, and the
//                  fallback whenever the chosen offer can't be used)
//
// FIRST EMAIL — the same rules for every offer, injected into every seam that writes an opener
// (pinned by tests/outreach-offer.test.ts, the same way OUTREACH_SUBJECT_RULES is): under 75 words,
// problem first, one-sentence paragraphs, NO link, never ask for a call, end on a question that asks
// permission. No link because a link in a first cold email from a stranger's own mailbox is a spam
// signal, and because "Mind if I send it over?" turns a cold email into a conversation.
//
// FOLLOW-UP — the first chaser carries the link (a tracked one for a gift: a sign-up through it is
// credited to the lead and stops the chasers, src/utils/outreach-offer.ts creditOfferSignup). The
// model never writes the address: it writes a sentence that introduces it, and the code puts the
// link on the next line — a model copying a long URL is how a typo reaches a stranger's inbox.

export const OUTREACH_OFFER_KINDS = ['gift', 'intro_offer', 'reply'] as const;
export type OutreachOfferKind = typeof OUTREACH_OFFER_KINDS[number];

export const OUTREACH_OFFER_LABELS: Record<OutreachOfferKind, string> = {
    gift: 'A free gift (a sign-up form with a free download)',
    intro_offer: 'Your free trial or introductory offer',
    reply: 'No offer — just ask a question',
};

export function cleanOutreachOfferKind(v: unknown): OutreachOfferKind | null {
    return OUTREACH_OFFER_KINDS.find((k) => k === v) ?? null;
}

/** The offer as the prompts see it — already resolved against the workspace's real forms and offer. */
export type ResolvedOutreachOffer =
    | { kind: 'reply'; /** Set when the owner chose another offer that can't be used right now. */ unusable?: string }
    | { kind: 'gift'; formId: number; formName: string; giftLabel: string; /** The form has its own page, so it can be linked to. */ linkable: boolean }
    | { kind: 'intro_offer'; summary: string; url: string | null };

/** One line for the owner (banner, chat) — what the emails offer. Pure. */
export function describeOutreachOffer(o: ResolvedOutreachOffer): string {
    if (o.kind === 'gift') return `a free "${o.giftLabel}" (from your "${o.formName}" sign-up form)`;
    if (o.kind === 'intro_offer') return o.summary.replace(/\.$/, '');
    return 'no offer — a question that invites a reply';
}

const MAX_WORDS = 75;

/** Every first email, whatever the offer. Exported for the seam-pinning test. */
export const OUTREACH_FIRST_EMAIL_RULES = `FIRST-EMAIL RULES (these override any length or style guidance above):
- Under ${MAX_WORDS} words in the body, not counting any sign-off — aim for 50 to 70, and count before you answer. Decision-makers read this on a phone.
- Open with THEIR situation or problem — something true of a business like theirs — never with us, our product or a compliment.
- At most ONE short sentence about what we do. Claim no result, time saving, percentage or number that the business's own information above does not state.
- At most FOUR paragraphs of ONE sentence each, after the greeting: their problem; what we do (optional); the offer; the question. Nothing else.
- No links, no web addresses and no attachments in this email.
- Never ask for a call, a meeting or "a few minutes of your time".
- End with ONE question they can answer in a word or two.`;

/** What the email asks for, by offer. Pure. */
function askFor(o: ResolvedOutreachOffer): string {
    if (o.kind === 'gift') {
        return `THE ASK: offer to send them our free "${o.giftLabel}" and ask permission — for example "Mind if I send it over?". Name it plainly and say in a few words who it helps; claim nothing about its contents beyond its title. Do not include it or link to it.`;
    }
    if (o.kind === 'intro_offer') {
        return `THE ASK: offer this in ONE short sentence — ${o.summary} — naming its length and the one term that matters most (for example "no card needed"), then ask whether they would like the link. Leave the other terms for later, and never change any of them. Do not include the link.`;
    }
    return 'THE ASK: no offer. Ask one simple, genuine question about the problem you opened with — one that is easy and worthwhile to answer.';
}

/** The block every first-email seam appends (discovery scoring, re-scoring, manual scoring, send-time). Pure. */
export function outreachFirstEmailBlock(o: ResolvedOutreachOffer | null | undefined): string {
    return `${OUTREACH_FIRST_EMAIL_RULES}\n${askFor(o ?? { kind: 'reply' })}`;
}

/** Follow-up step that carries the offer's link (the first chaser). Later chasers may mention it, not link it. */
export const OFFER_LINK_STEP = 1;

/** The link a follow-up carries, or null. Pure — the caller builds the URL (tracked for a gift). */
export function followUpLinkTarget(o: ResolvedOutreachOffer | null | undefined, stepNumber: number): 'gift' | 'intro_offer' | null {
    if (!o || stepNumber !== OFFER_LINK_STEP) return null;
    if (o.kind === 'gift' && o.linkable) return 'gift';
    if (o.kind === 'intro_offer' && o.url) return 'intro_offer';
    return null;
}

/** The block the follow-up prompt appends. `withLink` = the code will add the link after the body. Pure. */
export function outreachFollowUpBlock(o: ResolvedOutreachOffer | null | undefined, withLink: boolean): string {
    const lines = [`FOLLOW-UP RULES: under ${MAX_WORDS} words in the body. One-sentence paragraphs. Never ask for a call or a meeting.`];
    const offer = o ?? { kind: 'reply' as const };
    const thing = offer.kind === 'gift' ? `the free "${offer.giftLabel}"` : offer.kind === 'intro_offer' ? `the offer (${offer.summary.replace(/\.$/, '')})` : null;
    if (withLink && thing) {
        lines.push(`THIS follow-up includes the link to ${thing}, so they needn't reply to get it. End the body with one short sentence that introduces it — for example "Here it is in case it's useful:". The link is added automatically on the line after your last sentence, so NEVER write a web address yourself.`);
    } else if (thing) {
        lines.push(`You may mention ${thing} again, briefly. Do not write any link or web address.`);
    }
    return lines.join('\n');
}

/** The body with the offer's link on its own line after the last sentence. Pure. */
export function withOfferLink(body: string, link: string | null | undefined): string {
    if (!link) return body;
    return `${body.replace(/\s+$/, '')}\n${link}`;
}
