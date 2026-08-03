// src/utils/outreach-sequences.ts
// The ONE way to write sequence_enrolments — Phase 2b of
// docs/lead-generator-revenue-engine-plan.md §5.2. Same contract and same reasoning as
// revenue-ledger.ts recordEvent() and lead-threads.ts: one writer, so the invariants have exactly
// one place to be enforced.
//
// The invariants:
//   1. ONE active enrolment per thread. Two overlapping cadences means double the follow-ups.
//   2. A terminal enrolment has next_send_at = NULL. The worker claims on (state, next_send_at),
//      so a terminal row with a live timestamp is a row that can still send.
//   3. Every halt records WHY, from the closed SEQUENCE_HALT_REASONS vocabulary, and writes a
//      ledger event. "Sequences stop early" with no reason column is an unanswerable question.
//
// ── Best-effort by contract ──────────────────────────────────────────────────
// Every function resolves to null/false on failure and NEVER throws. Enrolment is bookkeeping that
// happens AFTER an email has already been delivered; failing the caller because a cadence row
// could not be written would turn a successful send into a user-visible error. On an un-migrated
// environment every call here quietly no-ops and the product degrades to today's behaviour:
// outreach sends once and never follows up.
//
// The corollary, as everywhere else in this subsystem: silence is a real outcome. If nothing is
// enrolled, look for the console.error lines below before concluding the call site never ran.

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    outreachSequences, sequenceSteps, sequenceEnrolments, leadThreads, leadMessages,
} from '../../db/schema';
import { recordEvent } from './revenue-ledger';
import { getBlueprintVersion } from './blueprint-version';
import {
    DEFAULT_SEQUENCE_STEPS,
    MAX_ENROLMENTS_PER_ORG_PER_DAY,
    MAX_STEPS_PER_ENROLMENT,
    isHaltReason,
    type SequenceHaltReason,
} from '../config/outreach-sequences';

type Db = ReturnType<typeof getDb>;

/** Start of the current UTC day — the window every per-day cap is measured over. */
export function startOfUtcDay(now: Date = new Date()): Date {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

/**
 * Add whole days to a moment, preserving the time of day.
 *
 * Deliberately NOT weekday-aware. `chaseDate()` in lead-generation.ts nudges off weekends because
 * it creates a human calendar reminder someone has to action; a sequence send needs no one present,
 * and shifting sends to Monday would pile a tenant's whole cadence onto one morning.
 */
export function addDays(from: Date, days: number): Date {
    const d = new Date(from);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

// ── Sequence provisioning ────────────────────────────────────────────────────

export interface SequenceStepRow { id: number; stepNumber: number; delayDays: number; bodyPrompt: string }

/**
 * Get this assistant's cadence, creating the default one if it has none.
 *
 * Auto-provisioning is what makes the engine work with no admin UI. There is no "configure a
 * sequence" screen yet, and a table only an operator could populate would mean the feature does
 * nothing for every existing tenant. The steps come from DEFAULT_SEQUENCE_STEPS so the shipped
 * cadence is reviewable in code rather than buried in a seed script.
 */
export async function ensureDefaultSequence(
    db: Db,
    organisationId: number,
    aiAssistantId: number,
): Promise<{ id: number; steps: SequenceStepRow[] } | null> {
    try {
        const [existing] = await db
            .select({ id: outreachSequences.id, isEnabled: outreachSequences.isEnabled })
            .from(outreachSequences)
            .where(eq(outreachSequences.aiAssistantId, aiAssistantId))
            .limit(1);

        let sequenceId = existing?.id ?? null;
        if (existing && !existing.isEnabled) return null;   // deliberately switched off

        if (!sequenceId) {
            // onConflictDoNothing + re-read: two approvals clicked at the same moment both reach
            // here, and the unique index on ai_assistant_id is what settles it. Racing to an
            // insert error and giving up would leave the loser with no cadence at all.
            const [created] = await db.insert(outreachSequences).values({
                organisationId, aiAssistantId,
            }).onConflictDoNothing({ target: outreachSequences.aiAssistantId })
                .returning({ id: outreachSequences.id });

            if (created) {
                sequenceId = created.id;
                await db.insert(sequenceSteps).values(
                    DEFAULT_SEQUENCE_STEPS.map((s) => ({
                        organisationId,
                        sequenceId: created.id,
                        stepNumber: s.stepNumber,
                        delayDays: s.delayDays,
                        bodyPrompt: s.bodyPrompt,
                    })),
                ).onConflictDoNothing();
            } else {
                const [won] = await db
                    .select({ id: outreachSequences.id })
                    .from(outreachSequences)
                    .where(eq(outreachSequences.aiAssistantId, aiAssistantId))
                    .limit(1);
                sequenceId = won?.id ?? null;
            }
        }
        if (!sequenceId) return null;

        const steps = await loadSteps(db, sequenceId);
        return steps ? { id: sequenceId, steps } : null;
    } catch (err) {
        logQuietly('ensureDefaultSequence', err);
        return null;
    }
}

/**
 * The enabled steps of a sequence, in order, truncated to MAX_STEPS_PER_ENROLMENT.
 *
 * The truncation is a hard ceiling independent of the table's contents: a misconfigured cadence
 * with forty rows must not be able to send forty emails. Enforced here rather than only at read
 * time so every caller inherits it.
 */
export async function loadSteps(db: Db, sequenceId: number): Promise<SequenceStepRow[] | null> {
    try {
        const rows = await db
            .select({
                id: sequenceSteps.id,
                stepNumber: sequenceSteps.stepNumber,
                delayDays: sequenceSteps.delayDays,
                bodyPrompt: sequenceSteps.bodyPrompt,
            })
            .from(sequenceSteps)
            .where(and(eq(sequenceSteps.sequenceId, sequenceId), eq(sequenceSteps.isEnabled, true)))
            .orderBy(sequenceSteps.stepNumber);
        return rows.slice(0, MAX_STEPS_PER_ENROLMENT);
    } catch (err) {
        logQuietly('loadSteps', err);
        return null;
    }
}

// ── Enrolment ────────────────────────────────────────────────────────────────

export interface EnrolInput {
    organisationId: number;
    aiAssistantId: number;
    leadThreadId: number;
    assistantRecordId?: number | null;
    discoveredLeadId?: number | null;
    contactEmail?: string | null;
    /** When the opening email went out. The first follow-up is scheduled relative to THIS. */
    sentAt?: Date;
}

/**
 * Enrol a lead in its assistant's cadence, immediately after the opening email was sent.
 *
 * Called from the send path, never from a UI action: enrolment is a consequence of having actually
 * emailed someone, so it cannot run for a lead that was never contacted. The human gate stays where
 * §2.5 puts it — the approval click that triggered the opening send is the consent for the cadence
 * that follows, which is exactly why the default cadence ends in a break-up email rather than
 * running indefinitely.
 *
 * Resolves to the enrolment id, null if it was skipped (already enrolled, capped, no cadence).
 */
export async function enrolInSequence(db: Db, input: EnrolInput): Promise<number | null> {
    try {
        const seq = await ensureDefaultSequence(db, input.organisationId, input.aiAssistantId);
        if (!seq || !seq.steps.length) return null;

        // Per-org daily enrolment cap — the cost/spam backstop from §5.2.
        const [{ count } = { count: 0 }] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(sequenceEnrolments)
            .where(and(
                eq(sequenceEnrolments.organisationId, input.organisationId),
                gte(sequenceEnrolments.createdAt, startOfUtcDay()),
            ));
        if (count >= MAX_ENROLMENTS_PER_ORG_PER_DAY) {
            console.warn('[outreach-sequences] daily enrolment cap reached, not enrolling', {
                organisationId: input.organisationId, count, cap: MAX_ENROLMENTS_PER_ORG_PER_DAY,
            });
            return null;
        }

        const sentAt = input.sentAt ?? new Date();
        const firstStep = seq.steps[0];

        // ON CONFLICT DO NOTHING against sequence_enrolments_thread_uidx. A lead re-approved, or
        // send_outreach called twice, must not produce a second cadence on the same thread — the
        // prospect would receive every follow-up twice.
        const [row] = await db.insert(sequenceEnrolments).values({
            organisationId: input.organisationId,
            aiAssistantId: input.aiAssistantId,
            sequenceId: seq.id,
            leadThreadId: input.leadThreadId,
            assistantRecordId: input.assistantRecordId ?? null,
            discoveredLeadId: input.discoveredLeadId ?? null,
            contactEmail: input.contactEmail ?? null,
            state: 'active',
            lastStepSent: 0,
            nextSendAt: addDays(sentAt, firstStep.delayDays),
        }).onConflictDoNothing({ target: sequenceEnrolments.leadThreadId })
            .returning({ id: sequenceEnrolments.id });

        if (!row) return null;   // already enrolled — the common, benign case

        await recordEvent(db, 'sequence_enrolled', {
            organisationId: input.organisationId,
            aiAssistantId: input.aiAssistantId,
            discoveredLeadId: input.discoveredLeadId ?? null,
            assistantRecordId: input.assistantRecordId ?? null,
            actor: 'agent',
            blueprintVersion: await getBlueprintVersion(db, input.aiAssistantId),
            payload: { sequenceId: seq.id, steps: seq.steps.length, firstSendAt: addDays(sentAt, firstStep.delayDays).toISOString() },
        });

        return row.id;
    } catch (err) {
        logQuietly('enrolInSequence', err);
        return null;
    }
}

// ── Progression and termination ──────────────────────────────────────────────

export interface EnrolmentRef {
    id: number;
    organisationId: number;
    aiAssistantId: number;
    assistantRecordId: number | null;
    discoveredLeadId: number | null;
    lastStepSent: number;
}

/**
 * Record that a step was sent and schedule the next one — or complete the enrolment when the
 * cadence has run out.
 *
 * Terminal rows get next_send_at = NULL. The worker claims on (state, next_send_at), so leaving a
 * timestamp on a completed row is the difference between "finished" and "will send again".
 */
export async function advanceEnrolment(
    db: Db,
    enrolment: EnrolmentRef,
    stepJustSent: number,
    steps: SequenceStepRow[],
    sentAt: Date = new Date(),
): Promise<'advanced' | 'completed' | null> {
    try {
        const next = steps.find((s) => s.stepNumber > stepJustSent);
        if (!next) {
            await db.update(sequenceEnrolments)
                .set({
                    state: 'completed', haltReason: 'max_steps', lastStepSent: stepJustSent,
                    nextSendAt: null, attempt: 0, lastError: null, updatedAt: sentAt,
                })
                .where(eq(sequenceEnrolments.id, enrolment.id));

            await recordEvent(db, 'sequence_completed', {
                organisationId: enrolment.organisationId,
                aiAssistantId: enrolment.aiAssistantId,
                discoveredLeadId: enrolment.discoveredLeadId,
                assistantRecordId: enrolment.assistantRecordId,
                actor: 'agent',
                blueprintVersion: await getBlueprintVersion(db, enrolment.aiAssistantId),
                payload: { stepsSent: stepJustSent, endedAt: 'max_steps' },
            });
            return 'completed';
        }

        await db.update(sequenceEnrolments)
            .set({
                lastStepSent: stepJustSent,
                nextSendAt: addDays(sentAt, next.delayDays),
                attempt: 0, lastError: null, updatedAt: sentAt,
            })
            .where(eq(sequenceEnrolments.id, enrolment.id));
        return 'advanced';
    } catch (err) {
        logQuietly('advanceEnrolment', err);
        return null;
    }
}

/**
 * Stop a cadence, permanently.
 *
 * `replied` is the reason we want to see most: it means Phase 2a's reply detection did its job and
 * the prospect is in a conversation rather than on a drip. Every other reason means the cadence was
 * cut short by a problem, which is why the vocabulary is closed and grouped in the ledger.
 */
export async function haltEnrolment(
    db: Db,
    enrolment: EnrolmentRef,
    reason: SequenceHaltReason,
    detail?: string | null,
): Promise<boolean> {
    try {
        if (!isHaltReason(reason)) {
            // Do not invent a key — the CHECK constraint would reject the row and we would lose
            // the halt entirely, leaving an active enrolment that keeps sending.
            console.error('[outreach-sequences] unknown halt reason, halting as manual:', reason);
            reason = 'manual';
        }
        await db.update(sequenceEnrolments)
            .set({
                state: 'halted', haltReason: reason, nextSendAt: null,
                lastError: detail ? String(detail).slice(0, 500) : null,
                updatedAt: new Date(),
            })
            .where(eq(sequenceEnrolments.id, enrolment.id));

        await recordEvent(db, 'sequence_halted', {
            organisationId: enrolment.organisationId,
            aiAssistantId: enrolment.aiAssistantId,
            discoveredLeadId: enrolment.discoveredLeadId,
            assistantRecordId: enrolment.assistantRecordId,
            actor: reason === 'manual' ? 'user' : 'agent',
            blueprintVersion: await getBlueprintVersion(db, enrolment.aiAssistantId),
            payload: { haltReason: reason, stepsSent: enrolment.lastStepSent, detail: detail ?? null },
        });
        return true;
    } catch (err) {
        logQuietly('haltEnrolment', err);
        return false;
    }
}

/** Record a failed send attempt; the worker halts the enrolment once attempts run out. */
export async function recordSendFailure(db: Db, enrolmentId: number, message: string): Promise<number | null> {
    try {
        const [row] = await db.update(sequenceEnrolments)
            .set({
                attempt: sql`${sequenceEnrolments.attempt} + 1`,
                lastError: String(message).slice(0, 500),
                updatedAt: new Date(),
            })
            .where(eq(sequenceEnrolments.id, enrolmentId))
            .returning({ attempt: sequenceEnrolments.attempt });
        return row?.attempt ?? null;
    } catch (err) {
        logQuietly('recordSendFailure', err);
        return null;
    }
}

/**
 * Halt every active enrolment on a thread that has been replied to.
 *
 * Belt to the worker's braces. recordInboundMessage flips the thread to 'replied' the moment a
 * reply lands, and the worker refuses to send to any thread that is not 'open' — but a reply that
 * arrives while a send is already in flight would otherwise leave an active enrolment pointing at a
 * replied thread. Called from the inbound path so the enrolment is closed at the same moment the
 * thread state changes, and safe to call repeatedly.
 */
export async function haltEnrolmentsForThread(db: Db, leadThreadId: number): Promise<number> {
    try {
        const rows = await db
            .select({
                id: sequenceEnrolments.id,
                organisationId: sequenceEnrolments.organisationId,
                aiAssistantId: sequenceEnrolments.aiAssistantId,
                assistantRecordId: sequenceEnrolments.assistantRecordId,
                discoveredLeadId: sequenceEnrolments.discoveredLeadId,
                lastStepSent: sequenceEnrolments.lastStepSent,
            })
            .from(sequenceEnrolments)
            .where(and(
                eq(sequenceEnrolments.leadThreadId, leadThreadId),
                eq(sequenceEnrolments.state, 'active'),
            ));

        let halted = 0;
        for (const r of rows) {
            if (await haltEnrolment(db, r, 'replied')) halted++;
        }
        return halted;
    } catch (err) {
        logQuietly('haltEnrolmentsForThread', err);
        return 0;
    }
}

/**
 * Halt every active enrolment on a lead record whose deal has reached a terminal outcome
 * (Phase 4.5 — docs/strategy-agent-plan.md §2).
 *
 * A cadence that keeps drip-feeding "just following up!" to someone who already signed — or who
 * already told us no — is the most visible way this system can embarrass its user. Marking an
 * outcome is exactly the moment we learn to stop, and nothing else in the pipeline learns it: the
 * worker's guards key off thread state and approval status, neither of which a won deal changes.
 *
 * Halted as `manual`, which is accurate (a human decided) and, until now, a reason with no caller —
 * the vocabulary and CHECK constraint have carried it since Phase 2b waiting for a first one.
 *
 * Routed through haltEnrolment() rather than a direct UPDATE, because that is what clears
 * `next_send_at`. A row whose state changed but whose timestamp did not is still claimable by the
 * worker, so a "stopped" cadence would keep sending.
 */
export async function haltEnrolmentsForRecord(db: Db, assistantRecordId: number): Promise<number> {
    try {
        const rows = await db
            .select({
                id: sequenceEnrolments.id,
                organisationId: sequenceEnrolments.organisationId,
                aiAssistantId: sequenceEnrolments.aiAssistantId,
                assistantRecordId: sequenceEnrolments.assistantRecordId,
                discoveredLeadId: sequenceEnrolments.discoveredLeadId,
                lastStepSent: sequenceEnrolments.lastStepSent,
            })
            .from(sequenceEnrolments)
            .where(and(
                eq(sequenceEnrolments.assistantRecordId, assistantRecordId),
                eq(sequenceEnrolments.state, 'active'),
            ));

        let halted = 0;
        for (const r of rows) {
            if (await haltEnrolment(db, r, 'manual', 'deal outcome recorded')) halted++;
        }
        return halted;
    } catch (err) {
        logQuietly('haltEnrolmentsForRecord', err);
        return 0;
    }
}

// ── Caps and context reads ───────────────────────────────────────────────────

/**
 * How many sequence follow-ups this org has sent today (UTC).
 *
 * Counted from lead_messages via the `seq:` template_version prefix rather than from a counter
 * column, because that is the record of what was ACTUALLY sent. A counter can drift from reality;
 * a message row cannot — it exists only if a send happened. Opening emails carry no such prefix and
 * are excluded by design: they are gated by the human approval click, not by this budget.
 */
export async function sequenceSendsToday(db: Db, organisationId: number): Promise<number> {
    try {
        const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(leadMessages)
            .where(and(
                eq(leadMessages.organisationId, organisationId),
                eq(leadMessages.direction, 'outbound'),
                gte(leadMessages.occurredAt, startOfUtcDay()),
                sql`${leadMessages.templateVersion} LIKE 'seq:%'`,
            ));
        return row?.count ?? 0;
    } catch (err) {
        logQuietly('sequenceSendsToday', err);
        // Fail closed on the cap: an unknown count must not read as zero, or a broken query would
        // silently remove the daily ceiling entirely.
        return Number.MAX_SAFE_INTEGER;
    }
}

/**
 * The conversation so far, oldest first, for the drafting model.
 *
 * This is the working-memory tier from §5.3 — a direct FK read, no embedding and no search. It is
 * what lets a follow-up reference what was actually said instead of restating the opener.
 */
export async function threadHistory(db: Db, leadThreadId: number, limit = 10): Promise<
    Array<{ direction: string; subject: string | null; body: string; occurredAt: Date }>
> {
    try {
        const rows = await db
            .select({
                direction: leadMessages.direction,
                subject: leadMessages.subject,
                body: leadMessages.body,
                occurredAt: leadMessages.occurredAt,
            })
            .from(leadMessages)
            .where(eq(leadMessages.leadThreadId, leadThreadId))
            .orderBy(desc(leadMessages.occurredAt))
            .limit(limit);
        return rows.reverse();
    } catch (err) {
        logQuietly('threadHistory', err);
        return [];
    }
}

/** Re-read a thread's state. The worker calls this immediately before every send. */
export async function threadState(db: Db, leadThreadId: number): Promise<string | null> {
    try {
        const [row] = await db
            .select({ state: leadThreads.state })
            .from(leadThreads)
            .where(eq(leadThreads.id, leadThreadId))
            .limit(1);
        return row?.state ?? null;
    } catch (err) {
        logQuietly('threadState', err);
        return null;
    }
}

/** Same shape as lead-threads.ts — postgres-js wraps the real failure, so read `cause`. */
function logQuietly(fn: string, err: unknown): void {
    const pg = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
    console.error(`[outreach-sequences] ${fn} failed (non-fatal)`, {
        pgCode: pg?.code,
        pgConstraint: pg?.constraint_name ?? pg?.constraint,
        cause: pg?.cause,
    }, err);
}
