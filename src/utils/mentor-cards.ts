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
//   mentor_business_stage   → update-assistant-context.ts PUT patchContext { businessStage } (its set-up answer, §3.1)
//   mentor_hire_recommendation → nothing is written: 1–3 Live roles from mentor-hire.ts, each linking to
//                             the catalogue (§3.5). The server fills the picks; the model only asks for it.
//   mentor_review_all       → the open suggestions together, each with its own tick (§3.13); the browser
//                             loads them from mentor.ts and applies each through its own card's action
//   setup_field_proposal    → src/utils/chat-setup-field.ts (any route; the Mentor may target any active assistant)
// The clicks are window.MentorApply (src/components/mentor-apply.js), shared by chat, the Overview tab and
// Inbox "Needs you". Every gap card carries a "why" — the evidence it's based on (§3.13). A gap card
// without one is dropped.

import { mentorSetupFieldPromptLine } from './chat-setup-field';

export const MENTOR_CARD_TYPES = [
    'mentor_business_profile', 'mentor_products', 'mentor_quiet_mode', 'mentor_support_request',
    'mentor_business_stage', 'mentor_hire_recommendation', 'mentor_review_all',
] as const;
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
    | { type: 'mentor_business_profile'; summary: string; why: string; asked: boolean; fields: Partial<Record<ProfileField, string>> }
    | { type: 'mentor_products'; summary: string; why: string; asked: boolean; products: Array<{ name: string; kind: string; description: string | null }> }
    | { type: 'mentor_quiet_mode'; summary: string; on: boolean; assistantId: number }
    | { type: 'mentor_support_request'; summary: string; destination: 'issue' | 'support'; subject: string; description: string }
    | { type: 'mentor_business_stage'; summary: string; assistantId: number }
    | { type: 'mentor_hire_recommendation'; summary: string; asked: boolean }
    | { type: 'mentor_review_all'; summary: string };

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
    // The user asked for this change directly: not counted towards the weekly cap, never held back (§3.13).
    const asked = u.asked === true;

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
            return { type: 'mentor_business_profile', summary, why, asked, fields };
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
            return { type: 'mentor_products', summary, why, asked, products };
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
        case 'mentor_business_stage':
            return { type: 'mentor_business_stage', summary, assistantId };
        case 'mentor_hire_recommendation':
            return { type: 'mentor_hire_recommendation', summary, asked };
        case 'mentor_review_all':
            return { type: 'mentor_review_all', summary };
    }
    return null;
}

/** The kinds of mentor_proposals rows (§3.13): only suggestions count towards the weekly cap. */
export function proposalKind(card: MentorCard): string | null {
    if (card.type === 'mentor_business_profile') return 'business_info_gap';
    if (card.type === 'mentor_products') return 'products_gap';
    if (card.type === 'mentor_hire_recommendation') return 'hire_recommendation';
    return null; // quiet mode, support, the opening question and Review all are not suggestions
}

/**
 * Remember a suggestion the Mentor showed (feeds the cap, dismiss reasons and Admin ▸ Mentor activity).
 * Returns its id, which the card carries so Dismiss and a saved click can record the answer. Never throws.
 */
export async function recordMentorProposal(
    db: any,
    row: { organisationId: number; aiAssistantId: number; kind: string; title: string; why: string; payload: unknown; chatSessionId: number | null; targetAssistantId?: number | null },
): Promise<number | null> {
    try {
        const { mentorProposals } = await import('../../db/schema');
        const [saved] = await db.insert(mentorProposals).values({
            organisationId: row.organisationId,
            aiAssistantId: row.aiAssistantId,
            kind: row.kind,
            title: row.title.slice(0, 300) || row.kind,
            evidence: [{ text: row.why }],
            payload: row.payload ?? {},
            chatSessionId: row.chatSessionId,
            targetAssistantId: row.targetAssistantId ?? null,
        }).returning({ id: mentorProposals.id });
        return saved?.id ?? null;
    } catch (err) {
        console.warn('[mentor-cards] could not record the proposal (non-blocking):', (err as Error)?.message);
        return null;
    }
}

/** The card instructions for the Mentor's prompt. */
export function mentorCardsPromptBlock(): string {
    return `CARDS — the only things you can change, and only by putting ONE card in "uiElement" for the user to approve (nothing changes until they click):

1. Fill in Business Information. Only for a gap listed under BUSINESS INFORMATION GAPS, drafted from what the user told you or what is already in the workspace — never invented. Include only the fields that change:
{"type":"mentor_business_profile","summary":"<one sentence>","why":"<the gap it fills and why it matters, from the figures above>","asked":false,"fields":{"businessDescription":"...","targetAudience":"...","industry":"...","websiteUrl":"https://..."}}

2. Add to Products & Services. Only products or services the user named or that already appear in the workspace. NEVER invent a price — leave prices for the user to add on the page:
{"type":"mentor_products","summary":"<one sentence>","why":"<why, from the gaps above>","asked":false,"products":[{"name":"...","kind":"product"|"service","description":"<optional>"}]}

3. Quiet mode — when they ask you to stop making suggestions (on) or to start again (off):
{"type":"mentor_quiet_mode","summary":"<one sentence>","on":true}

4. Ask Be More Swan for help, or report something broken — only when the user asks for it or describes a problem with Be More Swan itself. "issue" = something isn't working; "support" = a question, billing, or help. Write it in their words; never include passwords, card details or other people's personal details:
{"type":"mentor_support_request","summary":"<one sentence>","destination":"issue"|"support","subject":"<short>","description":"<what happened, what they expected, and where>"}

Set "asked": true ONLY when the user's latest message asked for exactly this change ("add my website", "fill in my products"); a suggestion you volunteer is "asked": false. Volunteered suggestions are limited to 3 a week and the user can dismiss them (see SUGGESTIONS THIS WEEK): never volunteer one they dismissed, and when the week's 3 are used, mention the gap in words instead. If they want a dismissed one back, they can ask you for it or use "Bring back" on your Overview tab.

5. The opening question — established business or new idea? Only when you don't know yet (see above), as part of your introduction. It shows both answers as buttons; their click saves it to your set-up, and they can change it later on your profile:
{"type":"mentor_business_stage","summary":"<one short sentence asking it>"}

6. ${mentorSetupFieldPromptLine()}

7. Who to hire next — whenever they ask who or what to hire (ALWAYS draw it then, "asked": true, even if you also advise fixing the team first — say that in the reply), or as a suggestion when WHO TO HIRE NEXT shows a clear gap. Never when WHO TO HIRE NEXT says there is no clear gap. The card lists the assistants under WHO TO HIRE NEXT with their reasons and whether the plan has room; you write only the summary. It hires nothing:
{"type":"mentor_hire_recommendation","summary":"<one sentence>","asked":true|false}

8. Review all — when they want to see, review or approve several of your suggestions at once (ALWAYS draw it then). It lists every suggestion still waiting, each with its own tick (none ticked), and applies only the ones they tick:
{"type":"mentor_review_all","summary":"<one sentence>"}

Cards 1, 2, 6 and 7 are suggestions when you volunteer them ("asked": false) and count towards the 3 a week. At most one card per reply, and at most one suggestion card unless they asked for more. Never say a card has been applied — the user decides.`;
}
