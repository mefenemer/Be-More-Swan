// src/utils/revenue-ledger.ts
// The ONE way to write a revenue_events row. Modelled on notify.ts — same contract, same reasons.
//
//   await recordEvent(db, 'lead_scored', {
//       organisationId: orgId,
//       aiAssistantId: assistant.id,
//       discoveredLeadId: lead.id,
//       actor: 'agent',
//       payload: { score: 85, rating: 'hot' },
//   });
//
// Design: docs/lead-generator-revenue-engine-plan.md §3. Vocabulary: src/config/revenue-events.ts.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// The ledger is an OBSERVER of the pipeline, never a participant. A failed ledger write must not
// break the discovery run, the outreach send or the approval click that triggered it — losing one
// analytics row is always preferable to failing the operation the user actually asked for.
// So this module resolves, logs and swallows. Callers need no try/catch and should NOT add one.
//
// The corollary, which is the thing to remember: a silent no-op is a real outcome here. If events
// are missing, look for the console.error line below before assuming the call site never ran.
//
// ── Why a single writer ──────────────────────────────────────────────────────
// The whole point of the ledger is that the Phase 5 Strategy Agent can aggregate it. That requires
// the closed vocabularies in revenue-events.ts to actually hold, and `outcome` to be non-NULL on
// exactly the three terminal events. Scattered inserts cannot guarantee either. Everything routes
// through here so the invariants have exactly one place to be enforced.

import { getDb } from '../../db/client';
import { revenueEvents } from '../../db/schema';
import {
    isEventType,
    isActor,
    isLossReason,
    isTerminal,
    OUTCOME_FOR_EVENT,
    type RevenueEventType,
    type RevenueActor,
    type LossReason,
} from '../config/revenue-events';

/**
 * Minimal structural type for a drizzle handle. Accepts both the top-level db from getDb() and a
 * transaction handle, which are different types but share the insert() shape used here — the same
 * accommodation notify.ts makes, and necessary because the discovery worker writes inside a tx.
 */
type Inserter = {
    insert: (table: typeof revenueEvents) => { values: (rows: any) => PromiseLike<unknown> };
};

export interface RecordEventInput {
    organisationId: number;
    aiAssistantId?: number | null;
    discoveredLeadId?: number | null;
    assistantRecordId?: number | null;

    /** Defaults to 'system'. Use 'agent' for an LLM-driven decision, 'user' for a human click. */
    actor?: RevenueActor;
    actorUserId?: number | null;

    /** Terminal events only — ignored (with a warning) on every other event type. */
    lossReason?: LossReason | null;
    valueGbp?: number | string | null;
    cycleDays?: number | null;

    /** The attribution join key. Supply both wherever they are known. */
    icpSnapshot?: Record<string, unknown> | null;
    blueprintVersion?: string | null;

    payload?: Record<string, unknown>;
    /** Defaults to now. Pass the real moment when backfilling or recording a past event. */
    occurredAt?: Date;
}

/** Coerce a money value to the string form postgres-js wants for `decimal`, or null. */
function toDecimal(v: number | string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : null;
}

/**
 * Append one event to the revenue ledger.
 *
 * Resolves to the new row id, or `null` when the write was skipped or failed — callers may ignore
 * the return value entirely. Never rejects.
 */
export async function recordEvent(
    db: Inserter,
    eventType: RevenueEventType | string,
    input: RecordEventInput,
): Promise<number | null> {
    try {
        // Reject an unknown event type rather than writing a row nothing can aggregate. A typo'd
        // event is worse than a missing one: it inflates row counts while being invisible to every
        // GROUP BY that matters.
        if (!isEventType(eventType)) {
            console.error('[revenue-ledger] unknown eventType, not recorded:', eventType);
            return null;
        }
        if (!Number.isInteger(input.organisationId)) {
            console.error('[revenue-ledger] missing organisationId, not recorded:', eventType);
            return null;
        }

        const actor: RevenueActor = isActor(input.actor) ? input.actor : 'system';

        // Derive `outcome` from the event type — never take it from the caller. A `deal_won`
        // carrying outcome 'lost' would silently corrupt every win-rate figure downstream, and
        // there is no reason for the two to be independently settable.
        const terminal = isTerminal(eventType);
        const outcome = terminal ? OUTCOME_FOR_EVENT[eventType] ?? null : null;

        // Terminal-only fields are dropped on non-terminal events. The partial index
        // `revenue_events_outcome_idx` and the Strategy Agent's aggregate both assume outcome is
        // non-NULL on exactly the terminal rows; letting a loss reason ride along on, say, an
        // `outreach_sent` would make "top loss reason" count events that lost nothing.
        let lossReason: string | null = null;
        if (terminal) {
            if (input.lossReason != null) {
                if (isLossReason(input.lossReason)) {
                    lossReason = input.lossReason;
                } else {
                    // Keep the event — the outcome still counts — but do not invent a key.
                    console.error('[revenue-ledger] unknown lossReason, storing as null:', input.lossReason);
                }
            }
        } else if (input.lossReason != null) {
            console.warn('[revenue-ledger] lossReason ignored on non-terminal event:', eventType);
        }

        const [row] = await (db.insert(revenueEvents).values({
            organisationId: input.organisationId,
            aiAssistantId: input.aiAssistantId ?? null,
            discoveredLeadId: input.discoveredLeadId ?? null,
            assistantRecordId: input.assistantRecordId ?? null,
            eventType,
            actor,
            actorUserId: input.actorUserId ?? null,
            outcome,
            lossReason,
            valueGbp: terminal ? toDecimal(input.valueGbp) : null,
            cycleDays: terminal && Number.isInteger(input.cycleDays) ? input.cycleDays! : null,
            icpSnapshot: input.icpSnapshot ?? null,
            blueprintVersion: input.blueprintVersion ?? null,
            payload: input.payload ?? {},
            ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        }) as unknown as { returning: (cols: { id: typeof revenueEvents.id }) => PromiseLike<{ id: number }[]> })
            .returning({ id: revenueEvents.id });

        return row?.id ?? null;
    } catch (err) {
        // Log the pg detail explicitly. A bare dump is how the assistant_records_source_check
        // violation behind the dead "Add Lead" button stayed invisible for weeks — the constraint
        // name is the single most useful field and it is not in the default message.
        const pg = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
        console.error('[revenue-ledger] failed to record event', {
            eventType,
            organisationId: input.organisationId,
            pgCode: pg?.code,
            pgConstraint: pg?.constraint_name ?? pg?.constraint,
            // postgres-js wraps the real failure — "Failed query" alone tells you nothing.
            cause: pg?.cause,
        }, err);
        return null;
    }
}

/**
 * Fire-and-forget wrapper for hot paths that must not await the ledger (the per-lead inner loop of
 * the discovery worker, which runs against a wall-clock budget). Safe precisely because
 * recordEvent never rejects — there is no unhandled-rejection risk.
 *
 * ⚠️ Do NOT use this in a Netlify function that returns immediately afterwards: the process can be
 * frozen before the insert lands. Only use it where more awaited work follows. See
 * [[background-trigger-must-be-awaited]] for the same failure mode elsewhere.
 */
export function recordEventAsync(db: Inserter, eventType: RevenueEventType | string, input: RecordEventInput): void {
    void recordEvent(db, eventType, input);
}

/** Whole-days between two moments, floored at 0. For `cycleDays` on a terminal event. */
export function cycleDaysBetween(from: Date | string, to: Date | string = new Date()): number {
    const a = from instanceof Date ? from : new Date(from);
    const b = to instanceof Date ? to : new Date(to);
    const ms = b.getTime() - a.getTime();
    return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : 0;
}

/** Convenience for call sites that already have a db handle from getDb(). */
export function ledgerDb() {
    return getDb() as unknown as Inserter;
}
