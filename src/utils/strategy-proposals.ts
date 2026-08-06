// src/utils/strategy-proposals.ts
// The ONE way to write a strategy_proposals row and the ONE way to apply a strategy change.
// Same discipline as revenue-ledger.ts recordEvent() and lead-threads.ts, for the same reason: the
// CHECK constraints and the change envelope only hold if there is a single writer.
//
// Design: docs/lead-generator-revenue-engine-plan.md §7, docs/strategy-agent-plan.md §4-§5.
//
// ── One apply path, deliberately (§5.4) ──────────────────────────────────────
// §2.6: "A human 'save as default' and an agent strategy pivot are the same operation. Same store,
// same audit row, same previousValue rollback, same blueprint recompile. Do not build two
// mechanisms." So applyStrategyChange() is the only thing in the codebase that writes a tunable
// strategy field, and §2.6's "Save as the new default" reaches it by creating a synthetic
// `source='human'` proposal rather than writing the field directly. Honouring that is what makes
// a human's save rollback-able on the same terms as the agent's.
//
// ── Error contract, which differs per function ───────────────────────────────
// proposeChange() NEVER THROWS — it runs inside a weekly cron iterating many orgs, and one org's
// bad row must not stop the others. It resolves to null and logs.
//
// apply / reject / rollback return a STRUCTURED RESULT rather than throwing or swallowing. These
// are user-initiated writes whose outcome the user has to see: "this field changed since the
// proposal was written" is not an error, it is an answer, and it needs to reach the screen with
// enough detail to act on.

import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, auditLogs, discoveryCampaigns, leadRejectFeedback, strategyProposals, templateFeedback,
} from '../../db/schema';
import {
    PROPOSAL_EXPIRY_DAYS, isProposalSource, isRejectReason, isValidValueFor, tunableField,
    type ProposalSource, type RejectReason, type TunableField,
} from '../config/strategy-proposals';

type Db = ReturnType<typeof getDb>;

// ── Results ──────────────────────────────────────────────────────────────────

export type DecisionFailure =
    | 'not_found'
    | 'not_pending'
    | 'not_applied'
    | 'already_rolled_back'
    | 'not_tunable'
    | 'invalid_value'
    | 'no_target'
    | 'invalid_reason'
    | 'changed_since'
    | 'write_failed';

export type DecisionResult =
    | { ok: true; proposalId: number; recompiled: boolean }
    /**
     * `changed_since` carries `currentValue` because the screen has to show the user WHAT it
     * changed to before asking them to decide again. A bare failure would leave them stuck.
     */
    | { ok: false; code: DecisionFailure; message: string; currentValue?: unknown };

function fail(code: DecisionFailure, message: string, currentValue?: unknown): DecisionResult {
    return currentValue === undefined ? { ok: false, code, message } : { ok: false, code, message, currentValue };
}

// ── Value comparison ─────────────────────────────────────────────────────────

/**
 * Canonical JSON with object keys sorted, so equality does not depend on key order.
 *
 * Load-bearing for the rollback guard: `{a:1,b:2}` and `{b:2,a:1}` are the same strategy, and a
 * naive JSON.stringify comparison would call an untouched field "changed since" and refuse every
 * rollback of a json-valued field.
 */
function canonical(v: unknown): string {
    const walk = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(walk);
        if (x && typeof x === 'object') {
            return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, walk((x as Record<string, unknown>)[k])]));
        }
        return x;
    };
    try {
        return JSON.stringify(walk(v)) ?? 'null';
    } catch {
        // A cycle cannot come out of jsonb, but a caller could hand one in. Treat it as unequal to
        // everything rather than throwing inside a guard whose job is to prevent data loss.
        return `__uncomparable__${Math.random()}`;
    }
}

const sameValue = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

// ── Reading and writing a tunable field ──────────────────────────────────────

/**
 * The field's current value.
 *
 * For a `campaign` field this is a MAP keyed by campaign id, not a single value: an assistant can
 * run several active campaigns and they need not agree. Flattening them to one "current" value
 * would make rollback restore a value that was never there for most of them.
 */
async function readFieldValue(db: Db, field: TunableField, assistantId: number): Promise<unknown> {
    if (field.store === 'onboarding') {
        const [row] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);
        if (!row) return undefined;
        const ctx = (row.onboardingContext && typeof row.onboardingContext === 'object'
            ? row.onboardingContext : {}) as Record<string, unknown>;
        return ctx[field.key] ?? null;
    }

    const rows = await db
        .select({ id: discoveryCampaigns.id, targetPersona: discoveryCampaigns.targetPersona })
        .from(discoveryCampaigns)
        .where(and(
            eq(discoveryCampaigns.aiAssistantId, assistantId),
            eq(discoveryCampaigns.status, 'active'),
        ));
    if (rows.length === 0) return undefined;
    return { byCampaign: Object.fromEntries(rows.map((r) => [String(r.id), r.targetPersona ?? null])) };
}

/**
 * Write one value to the field.
 *
 * ⚠️ BLAST RADIUS on a `campaign` field: the value is written to EVERY active campaign for the
 * assistant. That is what "the agent proposes a persona pivot" means — a persona that applied to
 * one campaign and not its siblings would leave the assistant targeting two different people. It is
 * also why the value being restored on rollback is per-campaign: they may have started out
 * different even though they end up the same.
 *
 * `restore` writes the per-campaign map back rather than one value, and is only used by rollback.
 */
async function writeFieldValue(
    db: Db, field: TunableField, assistantId: number, value: unknown, mode: 'set' | 'restore',
): Promise<boolean> {
    if (field.store === 'onboarding') {
        const [row] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);
        if (!row) return false;
        const ctx = (row.onboardingContext && typeof row.onboardingContext === 'object'
            ? row.onboardingContext : {}) as Record<string, unknown>;
        await db.update(aiAssistants)
            .set({ onboardingContext: { ...ctx, [field.key]: value }, updatedAt: new Date() })
            .where(eq(aiAssistants.id, assistantId));
        return true;
    }

    if (mode === 'restore') {
        const map = (value && typeof value === 'object' ? (value as Record<string, unknown>).byCampaign : null) as
            Record<string, unknown> | null;
        if (!map) return false;
        for (const [id, v] of Object.entries(map)) {
            const campaignId = Number(id);
            if (!Number.isInteger(campaignId)) continue;
            await db.update(discoveryCampaigns)
                .set({ targetPersona: v as Record<string, unknown> | null, updatedAt: new Date() })
                .where(and(
                    eq(discoveryCampaigns.id, campaignId),
                    // Re-assert ownership: the map came out of a jsonb column and a campaign can
                    // have been reassigned or deleted since the proposal was written.
                    eq(discoveryCampaigns.aiAssistantId, assistantId),
                ));
        }
        return true;
    }

    const rows = await db
        .select({ id: discoveryCampaigns.id })
        .from(discoveryCampaigns)
        .where(and(
            eq(discoveryCampaigns.aiAssistantId, assistantId),
            eq(discoveryCampaigns.status, 'active'),
        ));
    if (rows.length === 0) return false;
    await db.update(discoveryCampaigns)
        .set({ targetPersona: value as Record<string, unknown>, updatedAt: new Date() })
        .where(inArray(discoveryCampaigns.id, rows.map((r) => r.id)));
    return true;
}

/**
 * What a `set` write produces, given the current value — used to compare against on rollback.
 *
 * For a campaign field, applying one value to every active campaign means the post-apply state is
 * that same value repeated, so the thing rollback compares against is the map-of-identical-values,
 * not the scalar.
 */
function expectedAfterApply(field: TunableField, current: unknown, proposed: unknown): unknown {
    if (field.store === 'onboarding') return proposed;
    const map = (current && typeof current === 'object' ? (current as Record<string, unknown>).byCampaign : null) as
        Record<string, unknown> | null;
    if (!map) return proposed;
    return { byCampaign: Object.fromEntries(Object.keys(map).map((id) => [id, proposed])) };
}

// ── Blueprint recompile ──────────────────────────────────────────────────────

/**
 * Recompile the assistant's brief after an onboarding-backed field changed.
 *
 * Synchronous and scoped to ONE assistant, matching content-rules.ts. Deliberately not
 * triggerBlueprintRecompile() — that fires a platform-wide sweep for a price change and would be a
 * wildly disproportionate response to one org applying one proposal.
 *
 * Best-effort: the field write has already been persisted and committed, so a failed recompile
 * means the brief keeps its previous compilation until it recompiles for another reason. Failing
 * the whole apply here would tell the user nothing happened when in fact the field did change.
 */
async function recompileFor(assistantId: number, userId: number | null): Promise<boolean> {
    try {
        const { assembleBlueprint } = await import('./blueprint');
        await assembleBlueprint(assistantId, userId ? `user-${userId}` : 'strategy-agent', 'strategy_proposal');
        return true;
    } catch (err) {
        console.error('[strategy-proposals] blueprint recompile failed; the field change stands', { assistantId }, err);
        return false;
    }
}

// ── Banking the evidence ─────────────────────────────────────────────────────

/**
 * Mark the evidence rows that funded a proposal as spent.
 *
 * ⚠️ TWO EVIDENCE TABLES, TWO KEYS. `feedbackIds` are template_feedback rows (edit_pattern);
 * `rejectionIds` are lead_reject_feedback rows (lead_rejection). They are deliberately different
 * keys rather than one `ids` field discriminated by source: both are bare integer arrays, so a
 * mix-up would not throw — it would silently mark eight UNRELATED rows in the other tenant-shared
 * table as spent, permanently, and the only symptom would be a proposal that never comes back.
 *
 * ⚠️ Without this the SAME edits fund a proposal every week forever. The partial unique index only
 * prevents a second PENDING proposal for the field, so the moment one is applied or declined the
 * identical five edits are eligible again and the user gets the same suggestion back.
 *
 * Deliberately on APPLY and not on propose (§4.1): a declined proposal should leave its evidence
 * unspent, because the reject reason is fed back and the next run may reach a better answer from
 * the same material. `already_tried` is what suppresses a repeat, not the banking.
 *
 * Best-effort — the field change is already committed, and losing this bookkeeping is a duplicate
 * suggestion later, not a wrong strategy now.
 */
async function bankEvidence(db: Db, evidence: unknown): Promise<void> {
    const blob = (evidence && typeof evidence === 'object' ? evidence as Record<string, unknown> : {});
    const intsOf = (v: unknown): number[] =>
        Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];

    const feedbackIds = intsOf(blob.feedbackIds);
    if (feedbackIds.length) {
        try {
            await db.update(templateFeedback)
                .set({ appliedToTemplate: true })
                .where(inArray(templateFeedback.id, feedbackIds));
        } catch (err) {
            console.error('[strategy-proposals] could not bank the feedback rows; they may fund a duplicate proposal', err);
        }
    }

    const rejectionIds = intsOf(blob.rejectionIds);
    if (rejectionIds.length) {
        try {
            await db.update(leadRejectFeedback)
                .set({ appliedToTarget: true })
                .where(inArray(leadRejectFeedback.id, rejectionIds));
        } catch (err) {
            console.error('[strategy-proposals] could not bank the rejection rows; they may fund a duplicate proposal', err);
        }
    }
}

// ── Audit ────────────────────────────────────────────────────────────────────

async function audit(
    db: Db, actionType: string, proposalId: number, userId: number | null,
    previousState: unknown, newState: unknown,
): Promise<void> {
    await db.insert(auditLogs).values({
        userId: userId ?? null,
        actionType,
        resourceType: 'strategy_proposals',
        resourceId: String(proposalId),
        previousState: previousState as Record<string, unknown>,
        newState: newState as Record<string, unknown>,
    }).catch(() => { /* an audit failure must not undo a completed decision */ });
}

// ── Propose ──────────────────────────────────────────────────────────────────

export interface ProposeInput {
    organisationId: number;
    aiAssistantId: number;
    source: ProposalSource;
    targetField: string;
    proposedValue: unknown;
    /** Computed in SQL by the caller. NEVER taken from the model (§5.2). */
    evidence: Record<string, unknown>;
    expiryDays?: number;
}

/**
 * Persist one pending proposal.
 *
 * NEVER THROWS — resolves to the new row id, or null when the proposal was refused or a pending
 * proposal already exists for that field. A null is an ordinary outcome, not an error: the weekly
 * run iterates many orgs and must keep going.
 */
export async function proposeChange(db: Db, input: ProposeInput): Promise<number | null> {
    try {
        if (!Number.isInteger(input.organisationId)) {
            console.error('[strategy-proposals] missing organisationId, not proposed');
            return null;
        }
        if (!isProposalSource(input.source)) {
            console.error('[strategy-proposals] unknown source, not proposed:', input.source);
            return null;
        }

        // THE ENVELOPE. `targetField` is a key lookup against a frozen map — reject, never clamp.
        // A prompt instruction not to touch guardrails is a suggestion; this is a rule.
        const field = tunableField(input.targetField);
        if (!field) {
            console.error('[strategy-proposals] target field is not on the allow-list, not proposed:', input.targetField);
            return null;
        }
        if (!isValidValueFor(field, input.proposedValue)) {
            console.error('[strategy-proposals] proposed value does not match the field shape, not proposed:', {
                targetField: input.targetField, valueType: field.valueType,
            });
            return null;
        }

        // Snapshot what the field says NOW, so Apply is reversible without reconstructing it later.
        const previousValue = await readFieldValue(db, field, input.aiAssistantId);
        if (previousValue !== undefined && sameValue(previousValue, expectedAfterApply(field, previousValue, input.proposedValue))) {
            // Proposing what is already in place would spend the field's one pending slot on a
            // no-op and show the user an empty diff.
            console.log('[strategy-proposals] proposal matches the current value, skipped:', input.targetField);
            return null;
        }

        const expiresAt = new Date(Date.now() + (input.expiryDays ?? PROPOSAL_EXPIRY_DAYS) * 86_400_000);

        const [row] = await db.insert(strategyProposals).values({
            organisationId: input.organisationId,
            aiAssistantId: input.aiAssistantId,
            source: input.source,
            targetField: input.targetField,
            previousValue: (previousValue ?? null) as Record<string, unknown> | null,
            proposedValue: input.proposedValue as Record<string, unknown>,
            evidence: input.evidence,
            status: 'pending',
            expiresAt,
        })
            // ⚠️ The partial unique index is what makes "one pending proposal per field" true. The
            // conflict must be SKIPPED, not raised: a run that dies on a duplicate stops proposing
            // for every other org in the batch.
            .onConflictDoNothing()
            .returning({ id: strategyProposals.id });

        return row?.id ?? null;
    } catch (err) {
        const pg = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
        console.error('[strategy-proposals] failed to persist proposal', {
            targetField: input.targetField,
            organisationId: input.organisationId,
            pgCode: pg?.code,
            pgConstraint: pg?.constraint_name ?? pg?.constraint,
            // postgres-js wraps the real failure — "Failed query" alone tells you nothing.
            cause: pg?.cause,
        }, err);
        return null;
    }
}

// ── The human's own save (§2.6 class C, §5.4) ────────────────────────────────

/**
 * A human sets a tunable field directly — "save as the new default".
 *
 * §2.6: *"A human 'save as default' and an agent strategy pivot are the same operation. Same store,
 * same audit row, same previousValue rollback, same blueprint recompile. Do not build two
 * mechanisms."* So this does NOT write the field. It writes a synthetic `source='human'` proposal
 * and immediately applies it through applyStrategyChange(), which means a human's save is visible
 * in the same history, reversible on the same terms, and audited by the same row as the agent's.
 *
 * ⚠️ EXISTS SO THAT THE ALTERNATIVE DOES NOT GET WRITTEN. There is no UI calling this yet, and that
 * is deliberate: §2.6 names this option "a trap taken alone" because it generalises from n = 1, and
 * recommends the ⭐ flow (bank the reason, let a real sample fund the proposal) instead. What this
 * function prevents is the *next* person needing a human-save surface and reaching for
 * `db.update(aiAssistants)` — the second mechanism §5.4 forbids. `'human'` is already in the source
 * CHECK for the same reason, so wiring a surface later needs no migration.
 *
 * The evidence says n = 1 in plain terms rather than dressing a single click up as a finding.
 */
export async function saveHumanDefault(
    db: Db,
    opts: {
        organisationId: number;
        aiAssistantId: number;
        targetField: string;
        value: unknown;
        userId?: number | null;
        /** Free-text context for the history — e.g. which record the wording came from. */
        note?: string | null;
    },
): Promise<DecisionResult> {
    const field = tunableField(opts.targetField);
    if (!field) return fail('not_tunable', 'That is not a field this can change.');
    if (!isValidValueFor(field, opts.value)) {
        return fail('invalid_value', 'That value does not match the shape this field expects.');
    }

    // A pending agent proposal for the same field holds the one slot the partial unique index
    // allows. Expire it rather than failing the human's save: the person is stating what they want
    // the field to say, which settles the question the proposal was asking.
    await db.update(strategyProposals)
        .set({ status: 'expired' })
        .where(and(
            eq(strategyProposals.organisationId, opts.organisationId),
            eq(strategyProposals.targetField, opts.targetField),
            eq(strategyProposals.status, 'pending'),
        ));

    const id = await proposeChange(db, {
        organisationId: opts.organisationId,
        aiAssistantId: opts.aiAssistantId,
        source: 'human',
        targetField: opts.targetField,
        proposedValue: opts.value,
        evidence: {
            sampleSize: 1,
            source: 'human',
            note: opts.note ? String(opts.note).slice(0, 500) : null,
        },
        // Applied immediately below, so the window only has to outlive this function.
        expiryDays: 1,
    });
    if (!id) return fail('write_failed', 'That could not be saved. Nothing has been changed.');

    return applyStrategyChange(db, { proposalId: id, organisationId: opts.organisationId, userId: opts.userId });
}

// ── Apply ────────────────────────────────────────────────────────────────────

/**
 * Apply a pending proposal: write the field, stamp the row, audit, recompile.
 *
 * THE ONLY writer of a tunable strategy field. §2.6's "Save as the new default" must reach the
 * field through here (via a synthetic `source='human'` proposal), not by writing it directly.
 */
export async function applyStrategyChange(
    db: Db,
    opts: { proposalId: number; organisationId: number; userId?: number | null },
): Promise<DecisionResult> {
    const [p] = await db.select().from(strategyProposals).where(and(
        eq(strategyProposals.id, opts.proposalId),
        eq(strategyProposals.organisationId, opts.organisationId),
    )).limit(1);

    if (!p) return fail('not_found', 'That proposal no longer exists.');
    if (p.status !== 'pending') {
        return fail('not_pending', `This proposal has already been ${p.status === 'expired' ? 'allowed to lapse' : p.status}.`);
    }

    const field = tunableField(p.targetField);
    // Re-checked at apply time, not just at persist. The two happen days apart, the row is editable
    // by anything with database access in between, and the allow-list can shrink in a deploy.
    if (!field) return fail('not_tunable', 'That field is no longer one this agent may change.');
    if (!isValidValueFor(field, p.proposedValue)) {
        return fail('invalid_value', 'The proposed value no longer matches the shape this field expects.');
    }
    if (!Number.isInteger(p.aiAssistantId)) {
        return fail('no_target', 'This proposal is not attached to an assistant, so there is nothing to change.');
    }

    const assistantId = p.aiAssistantId as number;
    const before = await readFieldValue(db, field, assistantId);
    if (before === undefined) {
        return fail('no_target', field.store === 'campaign'
            ? 'This assistant has no active campaigns to apply the change to.'
            : 'That assistant no longer exists.');
    }

    const wrote = await writeFieldValue(db, field, assistantId, p.proposedValue, 'set');
    if (!wrote) return fail('write_failed', 'The change could not be written. Nothing has been altered.');

    await db.update(strategyProposals).set({
        status: 'applied',
        // Re-snapshot: `before` is what the field said at the moment of writing, which is the only
        // value a rollback can honestly restore. The persist-time snapshot may be days stale.
        previousValue: (before ?? null) as Record<string, unknown> | null,
        appliedAt: new Date(),
        decidedBy: opts.userId ?? null,
        decidedAt: new Date(),
    }).where(eq(strategyProposals.id, p.id));

    await audit(db, 'STRATEGY_PROPOSAL_APPLIED', p.id, opts.userId ?? null,
        { [p.targetField]: before }, { [p.targetField]: p.proposedValue });

    // Spend the evidence, so the same five edits cannot fund this suggestion again next week.
    if (p.source === 'edit_pattern') await bankEvidence(db, p.evidence);

    const recompiled = field.store === 'onboarding'
        ? await recompileFor(assistantId, opts.userId ?? null)
        : false;

    return { ok: true, proposalId: p.id, recompiled };
}

// ── Reject ───────────────────────────────────────────────────────────────────

/**
 * Decline a proposal with a reason from the closed vocabulary.
 *
 * The reason is required because it is an INPUT: the next run's prompt receives prior rejections,
 * so declining teaches the loop rather than being a dead end. The free-text note is stored and
 * shown to humans but never reaches the model.
 */
export async function rejectProposal(
    db: Db,
    opts: {
        proposalId: number; organisationId: number; reason: RejectReason;
        note?: string | null; userId?: number | null;
    },
): Promise<DecisionResult> {
    if (!isRejectReason(opts.reason)) {
        return fail('invalid_reason', 'Pick a reason from the list — a free-text reason cannot teach the next run.');
    }

    const [p] = await db.select({ id: strategyProposals.id, status: strategyProposals.status })
        .from(strategyProposals)
        .where(and(
            eq(strategyProposals.id, opts.proposalId),
            eq(strategyProposals.organisationId, opts.organisationId),
        )).limit(1);

    if (!p) return fail('not_found', 'That proposal no longer exists.');
    if (p.status !== 'pending') {
        return fail('not_pending', `This proposal has already been ${p.status === 'expired' ? 'allowed to lapse' : p.status}.`);
    }

    await db.update(strategyProposals).set({
        status: 'rejected',
        rejectReason: opts.reason,
        rejectNote: opts.note ? String(opts.note).slice(0, 2000) : null,
        decidedBy: opts.userId ?? null,
        decidedAt: new Date(),
    }).where(eq(strategyProposals.id, p.id));

    await audit(db, 'STRATEGY_PROPOSAL_REJECTED', p.id, opts.userId ?? null,
        { status: 'pending' }, { status: 'rejected', rejectReason: opts.reason });

    return { ok: true, proposalId: p.id, recompiled: false };
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/**
 * Undo an applied proposal by restoring `previousValue`.
 *
 * ⚠️ CHECKS BEFORE IT RESTORES. A naive rollback writes previousValue back unconditionally, which
 * silently destroys a hand-edit made after the proposal was applied. So it reads the field first,
 * and if it no longer equals what Apply wrote, it refuses and hands the current value back to the
 * screen instead. Same guard class as the next_send_at trap: the restore is not the risky part,
 * the assumption about intervening state is.
 *
 * The row STAYS 'applied' and gains `rolledBackAt`, so history still shows the change happened.
 */
export async function rollbackProposal(
    db: Db,
    opts: { proposalId: number; organisationId: number; userId?: number | null; force?: boolean },
): Promise<DecisionResult> {
    const [p] = await db.select().from(strategyProposals).where(and(
        eq(strategyProposals.id, opts.proposalId),
        eq(strategyProposals.organisationId, opts.organisationId),
    )).limit(1);

    if (!p) return fail('not_found', 'That proposal no longer exists.');
    if (!p.appliedAt) return fail('not_applied', 'This proposal was never applied, so there is nothing to undo.');
    if (p.rolledBackAt) return fail('already_rolled_back', 'This change has already been rolled back.');

    const field = tunableField(p.targetField);
    if (!field) return fail('not_tunable', 'That field is no longer one this agent may change.');
    if (!Number.isInteger(p.aiAssistantId)) return fail('no_target', 'This proposal is not attached to an assistant.');

    const assistantId = p.aiAssistantId as number;
    const current = await readFieldValue(db, field, assistantId);
    if (current === undefined) return fail('no_target', 'There is nothing left to roll back on this assistant.');

    const expected = expectedAfterApply(field, p.previousValue, p.proposedValue);
    if (!opts.force && !sameValue(current, expected)) {
        return fail(
            'changed_since',
            'This field has changed since the proposal was applied. Rolling back now would discard that edit.',
            current,
        );
    }

    const wrote = await writeFieldValue(db, field, assistantId, p.previousValue, 'restore');
    if (!wrote) return fail('write_failed', 'The previous value could not be restored. Nothing has been altered.');

    await db.update(strategyProposals)
        .set({ rolledBackAt: new Date() })
        .where(eq(strategyProposals.id, p.id));

    await audit(db, 'STRATEGY_PROPOSAL_ROLLED_BACK', p.id, opts.userId ?? null,
        { [p.targetField]: current }, { [p.targetField]: p.previousValue });

    const recompiled = field.store === 'onboarding'
        ? await recompileFor(assistantId, opts.userId ?? null)
        : false;

    return { ok: true, proposalId: p.id, recompiled };
}

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * Lapse every pending proposal past its expiry.
 *
 * ⚠️ Do NOT compute expiry on read. The review UI, the notification and the aggregate would each
 * need the same predicate, and one of them will forget it — at which point a lapsed proposal is
 * still clickable on one surface. One statement, one place.
 *
 * Runs inside the weekly proposer, which is already iterating orgs, rather than as a second cron.
 * Never throws: an expiry sweep failing must not abort the run that also proposes.
 */
export async function expirePendingProposals(db: Db, organisationId?: number): Promise<number> {
    try {
        const where = organisationId
            ? and(
                eq(strategyProposals.status, 'pending'),
                lt(strategyProposals.expiresAt, new Date()),
                eq(strategyProposals.organisationId, organisationId),
            )
            : and(
                eq(strategyProposals.status, 'pending'),
                lt(strategyProposals.expiresAt, new Date()),
            );
        const rows = await db.update(strategyProposals)
            .set({ status: 'expired' })
            .where(where)
            .returning({ id: strategyProposals.id });
        return rows.length;
    } catch (err) {
        console.error('[strategy-proposals] expiry sweep failed', err);
        return 0;
    }
}

/** Does this org have the table yet? The DDL is a MANUAL apply, so it can legitimately be absent. */
export async function strategyProposalsReady(db: Db): Promise<boolean> {
    try {
        await db.execute(sql`SELECT 1 FROM strategy_proposals LIMIT 1`);
        return true;
    } catch {
        return false;
    }
}
