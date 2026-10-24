// src/config/call-to-action.ts
// What a Social, Blog or Email assistant's work INVITES people to do. Pure — the database half is
// src/utils/call-to-action.ts.
//
// Owner, 2026-10-24: the call to action should be a setting, and it should be able to use the offers
// the workspace now records — the free trial / introductory offer (src/utils/intro-offer.ts) and a
// sign-up form's free download (the same "gift" the Lead Generator's outreach can offer). Before this
// the only call to action was the Social assistant's free-text "Primary CTA" answer; articles and
// emails had none, so the model invented one — and, in an email, a button pointing nowhere.
//
// Stored per assistant on its setup answers: onboarding_context.ctaOffer ('own' | 'intro_offer' |
// 'gift') and .ctaOfferFormId. Blank = 'own', how every assistant behaved before. One writer:
// org-products.ts PATCH { callToAction } — the Calls to action box on Business Information ▸
// Products & Services and the chat's call_to_action card.
//
// The link travels in the BRIEF, not only the system prompt: blogs and emails keep only links the
// brief supplied (groundLinks), so a call to action whose address were anywhere else would be
// stripped as invented.

export const CTA_KINDS = ['own', 'intro_offer', 'gift'] as const;
export type CtaKind = typeof CTA_KINDS[number];

export const CTA_LABELS: Record<CtaKind, string> = {
    own: 'Its own call to action',
    intro_offer: 'Your free trial or introductory offer',
    gift: 'A free download from a sign-up form',
};

/**
 * The system-prompt rule that makes the brief's CALL TO ACTION line binding. Live-model check
 * (2026-10-24): with the line only in the brief, a third of emails ended on a vague "see how it
 * works" instead. Blog and email prompts carry this; social has its own CTA wording. Pure.
 */
export const CTA_BINDING_RULE = 'If the brief has a "CALL TO ACTION —" line, the piece MUST end with exactly that call to action, using its link when it gives one. Do not replace it with a different or vaguer ask, and do not add a second one.';

/** The roles that write customer-facing content with a call to action. */
export const CTA_ROLES = ['social_media_manager', 'blog_writer', 'newsletter_editor'] as const;

export function cleanCtaKind(v: unknown): CtaKind | null {
    return CTA_KINDS.find((k) => k === v) ?? null;
}

export type ResolvedCta =
    | { kind: 'own'; /** Set when another choice can't be used right now, saying why. */ unusable?: string }
    | { kind: 'intro_offer'; summary: string; url: string | null }
    | { kind: 'gift'; formId: number; formName: string; giftLabel: string; url: string | null };

/** One line for the owner (Products & Services, chat). Pure. */
export function describeCta(c: ResolvedCta): string {
    if (c.kind === 'intro_offer') return `your offer — ${c.summary.replace(/\.$/, '')}`;
    if (c.kind === 'gift') return `the free "${c.giftLabel}" from your "${c.formName}" sign-up form`;
    return 'its own call to action';
}

export type CtaSurface = 'social' | 'blog' | 'email';

/**
 * The brief line for a drafter, or '' for 'own' (each surface keeps whatever it did before — the
 * Social assistant's own "Call to action" answer still applies). Pure.
 */
export function ctaBriefLine(c: ResolvedCta | null | undefined, surface: CtaSurface): string {
    if (!c || c.kind === 'own') return '';
    const where = surface === 'social'
        ? 'On posts that ask for something (not every post — most should simply give), the ask is'
        : surface === 'blog'
            ? 'The article MUST end with this as one short call to action:'
            : 'The email MUST end with this as its one closing call to action (a button):';
    const link = c.url ? ` Link: ${c.url}` : ' (there is no link — say where to find it only if the brief does)';
    if (c.kind === 'intro_offer') {
        return `CALL TO ACTION — ${where} the business's offer, stated exactly: ${c.summary} Don't change its length, terms or who can have it, and add no deadline.${link}`;
    }
    return `CALL TO ACTION — ${where} an invitation to get the free "${c.giftLabel}" by signing up. Say plainly what they get; claim nothing about its contents beyond the title.${link}`;
}
