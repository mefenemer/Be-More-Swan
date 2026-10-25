// src/utils/mentor-cards.ts
// The Business Mentor's proposal cards (docs/business-mentor-plan.md §3.3, §3.7, §3.13, §14). Pure,
// except recordMentorProposal.
//
// The model proposes; the server checks the shape here; the browser draws the card
// (disruptive-ui-registry.js) and the user's click calls the SAME endpoint the screen uses
// (chat-session.js):
//   mentor_business_profile → organisation-profile.ts POST (Business Information), read-merge-write
//   mentor_products         → org-products.ts POST, one per product (Business Information ▸ Products & Services)
//   mentor_quiet_mode       → update-assistant-context.ts PUT, read-merge-write (its "Quiet mode" set-up answer)
//   mentor_support_request  → support-tickets.ts POST, or issue-reports.ts POST for something broken
// Every gap card carries a "why" — the evidence it's based on (§3.13). A gap card without one is dropped.

export const MENTOR_CARD_TYPES = ['mentor_business_profile', 'mentor_products', 'mentor_quiet_mode', 'mentor_support_request'] as const;
export type MentorCardType = typeof MENTOR_CARD_TYPES[number];

const PROFILE_FIELDS = {
    businessDescription: { label: 'Business description', max: 2000 },
    targetAudience: { label: 'Who your customers are', max: 1000 },
    industry: { label: 'Industry', max: 120 },
    websiteUrl: { label: 'Website', max: 500 },
} as const;
type ProfileField = keyof typeof PROFILE_FIELDS;

// What org-products.ts accepts.
const PRODUCT_KINDS = ['product', 'service'] as const;

export type MentorCard =
    | { type: 'mentor_business_profile'; summary: string; why: string; fields: Partial<Record<ProfileField, string>> }
    | { type: 'mentor_products'; summary: string; why: string; products: Array<{ name: string; kind: string; description: string | null }> }
    | { type: 'mentor_quiet_mode'; summary: string; on: boolean; assistantId: number }
    | { type: 'mentor_support_request'; summary: string; destination: 'issue' | 'support'; subject: string; description: string };

const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t.slice(0, max) : null;
};

/**
 * The model's uiElement as a checked Mentor card; null when it isn't one; { error } when it is one but
 * unusable (the caller drops it and says so). `assistantId` = this Mentor, for the quiet-mode card.
 */
export function mentorCardFromUiElement(ui: unknown, assistantId: number): MentorCard | { error: string } | null {
    if (!ui || typeof ui !== 'object') return null;
    const u = ui as Record<string, unknown>;
    if (!(MENTOR_CARD_TYPES as readonly string[]).includes(String(u.type))) return null;
    const summary = text(u.summary, 300) ?? '';
    const why = text(u.why, 400);

    switch (u.type) {
        case 'mentor_business_profile': {
            if (!why) return { error: 'A suggestion needs to say why.' };
            const raw = (u.fields && typeof u.fields === 'object') ? u.fields as Record<string, unknown> : {};
            const fields: Partial<Record<ProfileField, string>> = {};
            for (const k of Object.keys(PROFILE_FIELDS) as ProfileField[]) {
                const v = text(raw[k], PROFILE_FIELDS[k].max);
                if (v) fields[k] = v;
            }
            if (!Object.keys(fields).length) return { error: 'There was nothing to fill in.' };
            if (fields.websiteUrl && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(fields.websiteUrl)) return { error: 'That website address doesn\'t look right.' };
            return { type: 'mentor_business_profile', summary, why, fields };
        }
        case 'mentor_products': {
            if (!why) return { error: 'A suggestion needs to say why.' };
            const list = Array.isArray(u.products) ? u.products : [];
            const products = list.slice(0, 8).flatMap((p) => {
                const o = (p && typeof p === 'object') ? p as Record<string, unknown> : {};
                const name = text(o.name, 120);
                if (!name) return [];
                const kind = (PRODUCT_KINDS as readonly string[]).includes(String(o.kind)) ? String(o.kind) : 'product';
                return [{ name, kind, description: text(o.description, 600) }];
            });
            if (!products.length) return { error: 'There were no products or services to add.' };
            return { type: 'mentor_products', summary, why, products };
        }
        case 'mentor_quiet_mode':
            if (typeof u.on !== 'boolean') return { error: 'Quiet mode needs to be on or off.' };
            return { type: 'mentor_quiet_mode', summary, on: u.on, assistantId };
        case 'mentor_support_request': {
            const subject = text(u.subject, 150);
            const description = text(u.description, 3000);
            if (!subject || !description) return { error: 'A message to Be More Swan needs a subject and a description.' };
            return { type: 'mentor_support_request', summary, destination: u.destination === 'issue' ? 'issue' : 'support', subject, description };
        }
    }
    return null;
}

/** The kinds of mentor_proposals rows (§3.13): only suggestions count towards the weekly cap. */
export function proposalKind(card: MentorCard): string | null {
    if (card.type === 'mentor_business_profile') return 'business_info_gap';
    if (card.type === 'mentor_products') return 'products_gap';
    return null; // quiet mode and support are the user's own requests, not suggestions
}

/** Remember a suggestion the Mentor showed (feeds the cap, dismiss reasons and Admin ▸ Mentor activity). Never throws. */
export async function recordMentorProposal(
    db: any,
    row: { organisationId: number; aiAssistantId: number; kind: string; title: string; why: string; payload: unknown; chatSessionId: number | null },
): Promise<void> {
    try {
        const { mentorProposals } = await import('../../db/schema');
        await db.insert(mentorProposals).values({
            organisationId: row.organisationId,
            aiAssistantId: row.aiAssistantId,
            kind: row.kind,
            title: row.title.slice(0, 300) || row.kind,
            evidence: [{ text: row.why }],
            payload: row.payload ?? {},
            chatSessionId: row.chatSessionId,
        });
    } catch (err) {
        console.warn('[mentor-cards] could not record the proposal (non-blocking):', (err as Error)?.message);
    }
}

/** The card instructions for the Mentor's prompt. */
export function mentorCardsPromptBlock(): string {
    return `CARDS — the only things you can change, and only by putting ONE card in "uiElement" for the user to approve (nothing changes until they click):

1. Fill in Business Information. Only for a gap listed under BUSINESS INFORMATION GAPS, drafted from what the user told you or what is already in the workspace — never invented. Include only the fields that change:
{"type":"mentor_business_profile","summary":"<one sentence>","why":"<the gap it fills and why it matters, from the figures above>","fields":{"businessDescription":"...","targetAudience":"...","industry":"...","websiteUrl":"https://..."}}

2. Add to Products & Services. Only products or services the user named or that already appear in the workspace. NEVER invent a price — leave prices for the user to add on the page:
{"type":"mentor_products","summary":"<one sentence>","why":"<why, from the gaps above>","products":[{"name":"...","kind":"product"|"service","description":"<optional>"}]}

3. Quiet mode — when they ask you to stop making suggestions (on) or to start again (off):
{"type":"mentor_quiet_mode","summary":"<one sentence>","on":true}

4. Ask Be More Swan for help, or report something broken — only when the user asks for it or describes a problem with Be More Swan itself. "issue" = something isn't working; "support" = a question, billing, or help. Write it in their words; never include passwords, card details or other people's personal details:
{"type":"mentor_support_request","summary":"<one sentence>","destination":"issue"|"support","subject":"<short>","description":"<what happened, what they expected, and where>"}

At most one card per reply, and at most one suggestion card (1 or 2) unless they asked for more. Never say a card has been applied — the user decides.`;
}
