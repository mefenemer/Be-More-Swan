// src/utils/mentor-plan-cards.ts
// The Business Mentor's Phase 2 chat cards (docs/business-mentor-plan.md §4, §14), rebuilt on the server
// from the real documents so the card shows what the page shows. Pure.
//
//   strategy_proposal op 'revise'  → save these sections into the draft (mentor.ts strategy_save — the
//                                    same action as the Plan tab's Save draft, form and canvas)
//   strategy_proposal op 'approve' → approve the draft (mentor.ts strategy_approve — the Plan tab's Approve)
//   strategy_proposal op 'draft'   → queue "Draft it for me" (mentor.ts strategy_draft, 1 task)
//   mentor_research                → queue "Look this up" (mentor.ts research, 1 task)
//   mentor_break_even              → nothing is written: the result is worked out in code (break-even.ts)
//                                    and "Open in the calculator" fills the Plan tab's calculator
//
// The browser draws them (disruptive-ui-registry.js); the clicks are window.MentorApply (mentor-apply.js).

import { breakEven, BREAK_EVEN_INPUTS, BREAK_EVEN_KEYS, type BreakEvenInput, type BreakEvenKey } from './break-even';
import { STRATEGY_KINDS, cleanStrategyPatch, diffStrategy, pickVersions, type StrategyDoc, type StrategyKind } from './strategy-documents';

export const QUESTION_MIN = 8;
export const QUESTION_MAX = 600;

/** Pure: a research question as asked, or why it can't be. */
export function cleanQuestion(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
    const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (t.length < QUESTION_MIN) return { ok: false, error: 'Write the question you want looked up.' };
    if (t.length > QUESTION_MAX) return { ok: false, error: `Keep the question under ${QUESTION_MAX} characters.` };
    return { ok: true, text: t };
}

export interface StrategyCardInput {
    op: 'revise' | 'approve' | 'draft';
    kind: StrategyKind;
    summary: string;
    why: string | null;
    asked: boolean;
    sections?: unknown;
    assumptions?: unknown;
}

export interface StrategyCard {
    type: 'strategy_proposal';
    op: 'revise' | 'approve' | 'draft';
    kind: StrategyKind;
    kindLabel: string;
    summary: string;
    why: string | null;
    asked: boolean;
    /** revise: each section that changes, now → next. */
    changes?: Array<{ key: string; label: string; now: string; next: string }>;
    sections?: Record<string, string>;
    assumptions?: Array<{ assumption: string; test: string }>;
    assumptionsNow?: Array<{ assumption: string; test: string }>;
    /** approve: the draft the user is looking at, and what changes against the approved version. */
    draftId?: number;
    draftUpdatedAt?: string | null;
    version?: number;
    approvedVersion?: number | null;
    changed?: Array<{ label: string; change: 'added' | 'removed' | 'changed' }>;
}

/** Pure: the card for a strategy proposal, against the documents as they are now. */
export function buildStrategyCard(input: StrategyCardInput, docs: StrategyDoc[]): StrategyCard | { error: string } {
    const def = STRATEGY_KINDS[input.kind];
    const base = { type: 'strategy_proposal' as const, op: input.op, kind: input.kind, kindLabel: def.label, summary: input.summary, why: input.why, asked: input.asked };
    const { draft, approved } = pickVersions(docs, input.kind);

    if (input.op === 'draft') return base;

    if (input.op === 'approve') {
        if (!draft) return { error: `There’s no ${def.label.toLowerCase()} draft to approve yet — save one first.` };
        const diff = diffStrategy(input.kind, approved?.body ?? null, draft.body);
        if (!diff.length) return { error: `The draft is the same as the approved ${def.label.toLowerCase()}.` };
        return {
            ...base, draftId: draft.id, draftUpdatedAt: draft.updatedAt ? draft.updatedAt.toISOString() : null,
            version: draft.version, approvedVersion: approved?.version ?? null,
            changed: diff.map((d) => ({ label: d.label, change: d.change })),
        };
    }

    const patch = cleanStrategyPatch(input.kind, { sections: input.sections, assumptions: input.assumptions });
    if (!patch) return { error: 'There was nothing to save.' };
    const current = draft ?? approved;
    const changes = def.sections.filter((s) => s.key in patch.sections)
        .map((s) => ({ key: s.key, label: s.label, now: current?.body.sections[s.key] ?? '', next: patch.sections[s.key] }))
        .filter((c) => c.now.trim() !== c.next.trim());
    const nowA = current?.body.assumptions ?? [];
    const assumptionsChange = patch.assumptions !== undefined && JSON.stringify(patch.assumptions) !== JSON.stringify(nowA);
    if (!changes.length && !assumptionsChange) return { error: 'That’s already what it says.' };
    return {
        ...base, changes,
        sections: Object.fromEntries(changes.map((c) => [c.key, c.next])),
        ...(assumptionsChange ? { assumptions: patch.assumptions, assumptionsNow: nowA } : {}),
    };
}

export interface BreakEvenCard {
    type: 'mentor_break_even';
    summary: string;
    inputs: Record<BreakEvenKey, BreakEvenInput | null>;
    labels: Record<BreakEvenKey, string>;
    result: { marginPerSale: number; salesToCoverSpend: number; salesToBreakEven: number; leadsToCoverSpend: number | null; leadsToBreakEven: number | null; assumed: string[] };
    sentence: string;
}

/** Pure: the break-even card, worked out in code; { error } when the inputs don't add up. */
export function buildBreakEvenCard(summary: string, rawInputs: unknown): BreakEvenCard | { error: string } {
    const r = breakEven(rawInputs && typeof rawInputs === 'object' ? rawInputs as Record<string, unknown> : {});
    if (!r.ok) return { error: r.error };
    return {
        type: 'mentor_break_even', summary,
        inputs: r.inputs,
        labels: Object.fromEntries(BREAK_EVEN_KEYS.map((k) => [k, BREAK_EVEN_INPUTS[k].label])) as Record<BreakEvenKey, string>,
        result: { marginPerSale: r.marginPerSale, salesToCoverSpend: r.salesToCoverSpend, salesToBreakEven: r.salesToBreakEven, leadsToCoverSpend: r.leadsToCoverSpend, leadsToBreakEven: r.leadsToBreakEven, assumed: r.assumed },
        sentence: r.sentence,
    };
}

/** The Phase 2 card instructions for the Mentor's prompt (appended to mentorCardsPromptBlock). */
export function mentorPlanCardsPromptLines(): string {
    const kinds = Object.entries(STRATEGY_KINDS).map(([k, d]) => `"${k}" (${d.label}: ${d.sections.map((s) => s.key).join(', ')}${d.hasAssumptions ? ', plus "assumptions"' : ''})`).join('; ');
    return `9. Strategy documents — the idea check, business plan and marketing plan on your Plan tab. Kinds and their section keys: ${kinds}.
   a) Save into the draft (the user's interview answers, a revised section, the Lean Canvas): include only the sections that change, written in full. Assumptions (idea check only) replace the whole list, 3–5 of them, each with a cheap test this month:
{"type":"strategy_proposal","op":"revise","kind":"<kind>","summary":"<one sentence>","why":"<what they told you, or the gap>","asked":true|false,"sections":{"<key>":"<text>"},"assumptions":[{"assumption":"...","test":"..."}]}
   b) Approve the draft — ONLY when the user says it's right and asks to approve it; never offer it unasked. Approving the business plan or marketing plan changes what every assistant drafts from (say so); approving the idea check only keeps it as their record of the idea and reaches no other assistant (never say it does):
{"type":"strategy_proposal","op":"approve","kind":"<kind>","summary":"<one sentence>","why":null,"asked":true}
   c) Draft a whole document for them in the background (1 task, about a minute; they review it before anything is saved) — when they ask you to write or pre-draft the whole plan:
{"type":"strategy_proposal","op":"draft","kind":"<kind>","summary":"<one sentence>","why":null,"asked":true}

10. Look something up with sources — whenever you would otherwise state a statistic, benchmark, market size, regulation or competitor fact you can't source from the details above. Whenever you offer to look something up, put THIS card in "uiElement" in the SAME reply (never offer it in words only) — the click is their yes. It runs in the background (1 task, about two minutes) and the answer comes back into this chat with its links:
{"type":"mentor_research","summary":"<one sentence>","question":"<the precise question to research>"}

11. Break-even — when they ask how many sales, leads or customers they need to cover a cost ("if I spend £500 on ads…"). Fill only the inputs they gave or that are in their business plan; anything else is an assumption and must be marked "source":"assumption" with a note. Never state the result yourself: it is worked out in code and shown on the card, with a sentence added under your reply:
{"type":"mentor_break_even","summary":"<one sentence>","inputs":{"price":{"value":<£>,"source":"you"|"plan"|"assumption","note":"..."},"costPerSale":{...},"fixedCosts":{...},"spend":{...},"conversionRate":{"value":<percent>,...}}}

Card 9a is a suggestion when you volunteer it ("asked": false) and counts towards the 3 a week; the user's own interview answers are always "asked": true.`;
}
