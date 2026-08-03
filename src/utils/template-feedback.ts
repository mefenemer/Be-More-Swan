// src/utils/template-feedback.ts
// The ONE way to write a template_feedback row — plan §2.6, the ⭐ option.
//
// Same contract and same reasoning as revenue-ledger.ts recordEvent() and outreach-sequences.ts:
// one writer, so the invariants have exactly one place to be enforced. Here that is the closed
// EDIT_REASONS vocabulary, which is the GROUP BY key for the entire edit-pattern proposer
// (docs/strategy-agent-plan.md §4.1) and is CHECK-constrained in the database.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// Feedback capture is an OBSERVER of the review flow. The edit has ALREADY been saved by the time
// anything here runs — that ordering is deliberate (§2.6: the edit ships immediately for this
// prospect, class A; the reason is evidence collected afterwards). Failing the caller because a
// feedback row could not be written would turn a successful edit into a user-visible error over
// analytics. So this module resolves, logs and swallows.
//
// The corollary, as everywhere else in this subsystem: silence is a real outcome. If no feedback is
// accumulating, look for the console.error below before concluding the call site never ran.

import type { getDb } from '../../db/client';
import { templateFeedback } from '../../db/schema';
import { isEditReason, type EditReason } from '../config/template-feedback';

type Db = ReturnType<typeof getDb>;

export interface DraftSnapshot {
    subject?: string | null;
    body: string;
}

export interface RecordTemplateEditInput {
    organisationId: number;
    /** NULL until the message is actually sent — a review-time edit precedes any lead_messages row. */
    leadMessageId?: number | null;
    /**
     * The assistant whose playbook this edit is about. **Supply it.**
     *
     * The edit-pattern proposer groups on this, and it cannot fall back to deriving it from
     * `leadMessageId` because the review-time path (the only writer today) leaves that NULL by
     * design. A row without it is invisible to the proposer — it still counts toward the progress
     * bar on the Strategy tab, which would make the threshold look reachable when it is not.
     */
    aiAssistantId?: number | null;
    /** The blueprint the draft was generated from. The attribution key, same as the ledger's. */
    templateVersion?: string | null;
    editReason: string;
    before: DraftSnapshot;
    after: DraftSnapshot;
}

const WORD_RE = /[a-z0-9']+/g;

function words(text: string): string[] {
    return String(text || '').toLowerCase().match(WORD_RE) ?? [];
}

function sentenceCount(text: string): number {
    const parts = String(text || '').split(/[.!?]+(?:\s|$)/).filter((s) => s.trim());
    return parts.length;
}

/**
 * A one-line, human-readable description of what the reviewer changed.
 *
 * Computed rather than LLM-summarised, deliberately. The clustering key is `edit_reason` — a closed
 * vocabulary — so this field is context for a human reading the evidence, not the thing the
 * proposer groups on. An LLM call on every draft edit would spend the org's task budget to
 * paraphrase a diff we can measure exactly, and it would fail on exactly the runs where the budget
 * is already exhausted.
 *
 * Reports retention against the ORIGINAL: "kept 18% of the wording" says the reviewer rewrote it,
 * whereas a raw length delta cannot distinguish a rewrite from a trim.
 */
export function summariseEdit(before: DraftSnapshot, after: DraftSnapshot): string {
    const bits: string[] = [];

    const beforeSubject = (before.subject ?? '').trim();
    const afterSubject = (after.subject ?? '').trim();
    const beforeBody = String(before.body ?? '').trim();
    const afterBody = String(after.body ?? '').trim();

    // Nothing moved. Say so plainly — "kept 100% of the wording" is technically true and reads as
    // though an edit happened, which would mislead anyone reading the evidence behind a proposal.
    if (beforeSubject === afterSubject && beforeBody === afterBody) return 'no measurable change';

    if (beforeSubject !== afterSubject) {
        bits.push(!beforeSubject ? 'subject added' : !afterSubject ? 'subject cleared' : 'subject rewritten');
    }

    const bw = words(before.body);
    const aw = words(after.body);
    if (bw.length) {
        const delta = Math.round(((aw.length - bw.length) / bw.length) * 100);
        if (Math.abs(delta) >= 5) bits.push(`${Math.abs(delta)}% ${delta < 0 ? 'shorter' : 'longer'}`);
    } else if (aw.length) {
        bits.push('body written from empty');
    }

    const bs = sentenceCount(before.body);
    const as = sentenceCount(after.body);
    if (bs !== as) bits.push(`${bs} → ${as} sentences`);

    // Multiset overlap: how much of the original survived, counting repeats once each. A plain Set
    // intersection would score a message that deleted every repetition as fully retained.
    if (bw.length) {
        const pool = new Map<string, number>();
        for (const w of bw) pool.set(w, (pool.get(w) ?? 0) + 1);
        let kept = 0;
        for (const w of aw) {
            const n = pool.get(w) ?? 0;
            if (n > 0) { kept++; pool.set(w, n - 1); }
        }
        const pct = Math.round((kept / bw.length) * 100);
        // Only worth stating when some wording was actually replaced. At 100% the words are all
        // still there and what changed was their order or punctuation — reported below instead.
        if (pct < 100) bits.push(`kept ${pct}% of the wording`);
    }

    // The bodies differ but every measure came out equal: same words, same length, same sentence
    // count. That is a reorder or a punctuation fix, and it is a real edit worth recording.
    return bits.length ? bits.join('; ') : 'reworded without changing the wording used';
}

/**
 * Record one human edit as evidence.
 *
 * Resolves to the new row id, or `null` when the write was skipped or failed — callers may ignore
 * the return value. Never rejects.
 */
export async function recordTemplateEdit(db: Db, input: RecordTemplateEditInput): Promise<number | null> {
    try {
        if (!Number.isInteger(input.organisationId)) {
            console.error('[template-feedback] missing organisationId, not recorded');
            return null;
        }
        // Refuse an unknown reason rather than writing a row nothing can group. The DB CHECK would
        // reject it anyway; catching it here means the log line names the value, which the
        // constraint error does not.
        if (!isEditReason(input.editReason)) {
            console.error('[template-feedback] unknown editReason, not recorded:', input.editReason);
            return null;
        }
        const editReason: EditReason = input.editReason;

        const diffSummary = summariseEdit(input.before, input.after);

        const [row] = await db.insert(templateFeedback).values({
            organisationId: input.organisationId,
            leadMessageId: input.leadMessageId ?? null,
            aiAssistantId: input.aiAssistantId ?? null,
            templateVersion: input.templateVersion ?? null,
            editReason,
            diffSummary: diffSummary.slice(0, 500),
            // Flipped by the Strategy Agent when a proposal built from this row is APPLIED, so the
            // same edits cannot fund a second proposal (docs/strategy-agent-plan.md §4.1).
            appliedToTemplate: false,
        }).returning({ id: templateFeedback.id });

        return row?.id ?? null;
    } catch (err) {
        // Name the constraint explicitly. postgres-js wraps the real failure and "Failed query"
        // alone tells you nothing — the same lesson recorded in revenue-ledger.ts.
        const pg = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
        console.error('[template-feedback] failed to record edit', {
            organisationId: input.organisationId,
            editReason: input.editReason,
            pgCode: pg?.code,
            pgConstraint: pg?.constraint_name ?? pg?.constraint,
            cause: pg?.cause,
        }, err);
        return null;
    }
}
