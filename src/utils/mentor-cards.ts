// src/utils/mentor-cards.ts
// The Business Mentor's proposal cards (docs/business-mentor-plan.md §3.3, §3.7, §3.13, §14). Pure,
// except recordMentorProposal.
//
// The model proposes; the server checks the shape here; the browser draws the card
// (disruptive-ui-registry.js) and the user's click calls the SAME endpoint the screen uses
// (chat-session.js):
//   mentor_business_profile → organisation-profile.ts POST (Business Information), read-merge-write
//   mentor_products         → org-products.ts POST, one per product (Business Information ▸ Products & Services)
//   mentor_products_remove  → org-products.ts DELETE, one per product — only when the user asked; rebuilt from
//                             the rows by resolveProductRemoval, so the card names what is really deleted
//   mentor_quiet_mode       → update-assistant-context.ts PUT, read-merge-write (its "Quiet mode" set-up answer)
//   mentor_support_request  → support-tickets.ts POST, or issue-reports.ts POST for something broken
//   mentor_business_stage   → update-assistant-context.ts PUT patchContext { businessStage } (its set-up answer, §3.1)
//   mentor_hire_recommendation → nothing is written: 1–3 Live roles from mentor-hire.ts, each linking to
//                             the catalogue (§3.5). The server fills the picks; the model only asks for it.
//   mentor_review_all       → the open suggestions together, each with its own tick (§3.13); the browser
//                             loads them from mentor.ts and applies each through its own card's action
//   setup_field_proposal    → src/utils/chat-setup-field.ts (any route; the Mentor may target any active assistant)
//   strategy_proposal, mentor_research, mentor_break_even (Phase 2) → checked here, rebuilt from the
//                             documents by src/utils/mentor-plan-cards.ts, applied through mentor.ts
//   mentor_commitments (Phase 3) → mentor.ts commitments_add / commitment_close — the same actions as the
//                             Commitments list on its Results tab (src/utils/mentor-commitments.ts). A
//                             "close" card is rebuilt from the row (closeCommitmentCard).
//   mentor_draft_request (Phase 3) → generate-post.ts, as "Create a Post" does (src/utils/mentor-draft-request.ts)
// The clicks are window.MentorApply (src/components/mentor-apply.js), shared by chat, the Overview tab and
// Inbox "Needs you". Every gap card carries a "why" — the evidence it's based on (§3.13). A gap card
// without one is dropped.

import { mentorSetupFieldPromptLine } from './chat-setup-field';
import { mentorGoalPromptLine } from './chat-goals';
import { isStrategyKind, type StrategyKind } from './strategy-documents';
import { cleanQuestion, mentorPlanCardsPromptLines } from './mentor-plan-cards';
import { cleanCommitmentTexts, MAX_PER_WEEK } from './mentor-commitments';
import { draftRequestPromptLine } from './mentor-draft-request';

export const MENTOR_CARD_TYPES = [
    'mentor_business_profile', 'mentor_products', 'mentor_products_remove', 'mentor_quiet_mode', 'mentor_support_request',
    'mentor_business_stage', 'mentor_hire_recommendation', 'mentor_review_all',
    'strategy_proposal', 'mentor_research', 'mentor_break_even',
    'mentor_commitments',
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
    | { type: 'mentor_products_remove'; summary: string; productIds: number[]; products?: Array<{ id: number; name: string }> }
    | { type: 'mentor_quiet_mode'; summary: string; on: boolean; assistantId: number }
    | { type: 'mentor_support_request'; summary: string; destination: 'issue' | 'support'; subject: string; description: string }
    | { type: 'mentor_business_stage'; summary: string; assistantId: number }
    | { type: 'mentor_hire_recommendation'; summary: string; asked: boolean }
    | { type: 'mentor_review_all'; summary: string }
    | { type: 'strategy_proposal'; op: 'revise' | 'approve' | 'draft'; kind: StrategyKind; summary: string; why: string | null; asked: boolean; sections?: unknown; assumptions?: unknown }
    | { type: 'mentor_research'; summary: string; question: string }
    | { type: 'mentor_break_even'; summary: string; inputs: Record<string, unknown> }
    | { type: 'mentor_commitments'; op: 'set'; summary: string; texts: string[] }
    | { type: 'mentor_commitments'; op: 'close'; summary: string; commitmentId: number };

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
        case 'mentor_products_remove': {
            // Deleting is for good, so never volunteered: the user asked (prod 2026-10-26: the Mentor could
            // add products but had to send the owner to the page to delete three TEST ones).
            if (!asked) return { error: 'I only remove products when you ask me to.' };
            const ids = [...new Set((Array.isArray(u.productIds) ? u.productIds : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
            if (!ids.length) return { error: 'It didn’t say which products to remove.' };
            return { type: 'mentor_products_remove', summary, productIds: ids };
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
        case 'strategy_proposal': {
            const op = u.op === 'approve' || u.op === 'draft' ? u.op : u.op === 'revise' ? 'revise' : null;
            if (!op) return { error: 'A plan card needs to say what to do.' };
            if (!isStrategyKind(u.kind)) return { error: 'Which document?' };
            // The user's own interview answers are always theirs; a volunteered revision is a suggestion.
            const isAsked = op !== 'revise' || u.kind === 'idea_check' ? true : asked;
            if (op === 'revise' && !isAsked && !why) return { error: 'A suggestion needs to say why.' };
            return { type: 'strategy_proposal', op, kind: u.kind, summary, why, asked: isAsked, sections: u.sections, assumptions: u.assumptions };
        }
        case 'mentor_research': {
            const q = cleanQuestion(u.question);
            if (!q.ok) return { error: q.error };
            return { type: 'mentor_research', summary, question: q.text };
        }
        case 'mentor_break_even':
            return { type: 'mentor_break_even', summary, inputs: (u.inputs && typeof u.inputs === 'object') ? u.inputs as Record<string, unknown> : {} };
        case 'mentor_commitments': {
            if (u.op === 'close') {
                const id = Number(u.commitmentId);
                if (!Number.isInteger(id) || id <= 0) return { error: 'It didn’t say which commitment.' };
                return { type: 'mentor_commitments', op: 'close', summary, commitmentId: id };
            }
            const c = cleanCommitmentTexts(u.texts);
            if (!c.ok) return { error: c.error };
            return { type: 'mentor_commitments', op: 'set', summary, texts: c.texts };
        }
    }
    return null;
}

/**
 * Pure: a VOLUNTEERED Business Information card fills gaps only — a field that already has a value is
 * dropped, so a suggestion can never overwrite what the owner wrote (staging, 2026-10-26: the weekly
 * review offered to replace a filled-in description and industry). Null when nothing is left to fill.
 * A card the user asked for ("asked") may change a filled field: they asked.
 */
export function onlyGapFields(
    fields: Partial<Record<ProfileField, string>>,
    current: { description?: string | null; industry?: string | null; website?: string | null; targetAudience?: string | null },
): Partial<Record<ProfileField, string>> | null {
    const filled: Record<ProfileField, boolean> = {
        businessDescription: !!current.description?.trim(), industry: !!current.industry?.trim(),
        websiteUrl: !!current.website?.trim(), targetAudience: !!current.targetAudience?.trim(),
    };
    const out = Object.fromEntries(Object.entries(fields).filter(([k]) => !filled[k as ProfileField])) as Partial<Record<ProfileField, string>>;
    return Object.keys(out).length ? out : null;
}

/**
 * A removal card rebuilt from this workspace's rows: the names shown are the real ones, and an id that
 * isn't this workspace's is dropped. { error } when none is left.
 */
export async function resolveProductRemoval(
    db: any, orgId: number, card: Extract<MentorCard, { type: 'mentor_products_remove' }>,
): Promise<Extract<MentorCard, { type: 'mentor_products_remove' }> | { error: string }> {
    const { orgProducts } = await import('../../db/schema');
    const { and, eq, inArray } = await import('drizzle-orm');
    const rows: Array<{ id: number; name: string }> = await db.select({ id: orgProducts.id, name: orgProducts.name }).from(orgProducts)
        .where(and(eq(orgProducts.organisationId, orgId), inArray(orgProducts.id, card.productIds)));
    if (!rows.length) return { error: 'Those products aren’t on your list any more.' };
    const products = card.productIds.flatMap((id) => rows.filter((r) => r.id === id));
    return { ...card, productIds: products.map((p) => p.id), products };
}

/** The kinds of mentor_proposals rows (§3.13): only suggestions count towards the weekly cap. */
export function proposalKind(card: MentorCard): string | null {
    if (card.type === 'mentor_business_profile') return 'business_info_gap';
    if (card.type === 'mentor_products') return 'products_gap';
    if (card.type === 'mentor_hire_recommendation') return 'hire_recommendation';
    if (card.type === 'strategy_proposal' && card.op === 'revise' && !card.asked) return 'strategy_revision';
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

2b. Remove from Products & Services — ONLY when the user's latest message asks you to remove or delete products or services (never volunteer it; suggest it in words instead). Name them by their #number under PRODUCTS & SERVICES. Their click deletes them for good:
{"type":"mentor_products_remove","summary":"<one sentence>","asked":true,"productIds":[<#number>, ...]}

3. Quiet mode — when they ask you to stop making suggestions (on) or to start again (off):
{"type":"mentor_quiet_mode","summary":"<one sentence>","on":true}

4. Ask Be More Swan for help, or report something broken — only when the user asks for it or describes a problem with Be More Swan itself. "issue" = something isn't working; "support" = a question, billing, or help. Write it in their words; never include passwords, card details or other people's personal details:
{"type":"mentor_support_request","summary":"<one sentence>","destination":"issue"|"support","subject":"<short>","description":"<what happened, what they expected, and where>"}

Set "asked": true ONLY when the user's latest message asked for exactly this change ("add my website", "fill in my products"); a suggestion you volunteer is "asked": false. Volunteered suggestions are limited to 3 a week and the user can dismiss them (see SUGGESTIONS THIS WEEK): never volunteer one they dismissed, and when the week's 3 are used, mention the gap in words instead. If they want a dismissed one back, they can ask you for it or use "Bring back" on your Overview tab.

5. The opening question — established business or new idea? Only when you don't know yet (see above), as part of your introduction. It shows both answers as buttons; their click saves it to your set-up, and they can change it later on your profile:
{"type":"mentor_business_stage","summary":"<one short sentence asking it>"}

6. ${mentorSetupFieldPromptLine()}

6b. ${mentorGoalPromptLine()}

7. Who to hire next — whenever they ask who or what to hire (ALWAYS draw it then, "asked": true, even if you also advise fixing the team first — say that in the reply), or as a suggestion when WHO TO HIRE NEXT shows a clear gap. Never when WHO TO HIRE NEXT says there is no clear gap. The card lists the assistants under WHO TO HIRE NEXT with their reasons and whether the plan has room; you write only the summary. It hires nothing:
{"type":"mentor_hire_recommendation","summary":"<one sentence>","asked":true|false}

8. Review all — when they want to see, review or approve several of your suggestions at once (ALWAYS draw it then). It lists every suggestion still waiting, each with its own tick (none ticked), and applies only the ones they tick:
{"type":"mentor_review_all","summary":"<one sentence>"}

${mentorPlanCardsPromptLines()}

${mentorCommitmentsPromptLines()}

${draftRequestPromptLine()}

Cards 1, 2, 6 and 7 and the post request are suggestions when you volunteer them ("asked": false) and count towards the 3 a week. At most one card per reply, and at most one suggestion card unless they asked for more. Never say a card has been applied — the user decides.`;
}

/** The commitments card (§5.1): set this week's, or the end-of-week check on one. */
export function mentorCommitmentsPromptLines(): string {
    return `Commitments — 1 to ${MAX_PER_WEEK} things the user will do THIS week, in their words (when they agree to some, or ask to set them). Their click saves them to the Commitments list on your Results tab, owned by them:
{"type":"mentor_commitments","op":"set","summary":"<one sentence>","texts":["...", "..."]}
The end-of-week check — for ONE commitment listed under COMMITMENTS that is still open (by its #number). Their click marks it done, missed (they pick why from a fixed list) or dropped:
{"type":"mentor_commitments","op":"close","summary":"<one short question: how did it go?>","commitmentId":<its #number>}`;
}

/**
 * The user asked who (or what) to hire, or to review their suggestions together. Live on staging
 * (2026-10-25, Opus 5.5) the Mentor answered "who should I hire next?" in words three times and drew
 * no card, even saying "on the card below". Both cards are filled by the server anyway, so when the
 * model draws none the chat route asks for it on the user's behalf (asked: true).
 */
export function cardTheUserAskedFor(typed: string): MentorCard | null {
    const t = typed.toLowerCase();
    if (/\b(who|which|what)\b[^?.!\n]{0,40}\b(hire|recruit|take on)\b/.test(t) || /\bhire next\b/.test(t)) {
        return { type: 'mentor_hire_recommendation', summary: 'Who I’d hire next', asked: true };
    }
    // Phase 2, same lesson (staging, 2026-10-25): asked to "approve my idea check", Opus 5.5 said "the
    // approval card is below" and drew none. The card is rebuilt from the documents anyway.
    const plan = /\b(idea check|business plan|marketing plan)\b/.exec(t);
    const kind = plan ? ({ 'idea check': 'idea_check', 'business plan': 'business_plan', 'marketing plan': 'marketing_plan' } as const)[plan[1] as 'idea check'] : null;
    if (kind && /\bapprove\b/.test(t) && !/\b(don['’]?t|do not|not yet|before)\b[^?.!\n]{0,15}\bapprove\b/.test(t) && !/\bapprove\b[^?.!\n]{0,40}\byet\b/.test(t)) {
        return { type: 'strategy_proposal', op: 'approve', kind, summary: 'Approve your plan', why: null, asked: true };
    }
    if (kind && kind !== 'idea_check' && /\b(draft|write|pre-?draft)\b[^?.!\n]{0,25}\b(business plan|marketing plan)\b/.test(t)) {
        return { type: 'strategy_proposal', op: 'draft', kind, summary: 'I’ll draft it for you to check', why: null, asked: true };
    }
    if (/\b(review|approve|see|show|go through)\b[^?.!\n]{0,30}\b(all|every|several|your)\b[^?.!\n]{0,30}\bsuggestions?\b/.test(t)) {
        return { type: 'mentor_review_all', summary: 'Your suggestions that are still waiting' };
    }
    return null;
}
