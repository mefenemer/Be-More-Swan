// src/utils/lead-reject-feedback.ts
// The ONE way to write a lead_reject_feedback row.
//
// Same contract and same reasoning as template-feedback.ts and revenue-ledger.ts: one writer, so
// the invariants have exactly one place to be enforced. Here that is the closed
// LEAD_REJECT_REASONS vocabulary, which is CHECK-constrained in the database and would be the
// GROUP BY key for any future retargeting proposer.
//
// ── Never throws ─────────────────────────────────────────────────────────────
// The rejection has ALREADY been committed by the time anything here runs, and that ordering is
// deliberate: the reviewer's decision about THIS lead ships immediately, and the reason is evidence
// collected afterwards. Failing the caller because a feedback row could not be written would turn a
// successful rejection into a user-visible error over analytics.
//
// The corollary, as everywhere else in this subsystem: silence is a real outcome. If no feedback is
// accumulating, look for the console.error below before concluding the call site never ran.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { discoveredLeads, leadRejectFeedback } from '../../db/schema';
import { isLeadRejectReason, type LeadRejectReason } from '../config/lead-reject-reasons';

type Db = ReturnType<typeof getDb>;

export interface RecordLeadRejectionInput {
    organisationId: number;
    aiAssistantId: number;
    /** The rejected record. Used to resolve discovery provenance when the caller has not. */
    assistantRecordId: number;
    reason: string;
}

export interface LeadRejectionResult {
    id: number | null;
    /** The lead's domain, when discovery found one — what the caller may offer to exclude. */
    domain: string | null;
    /** The campaign that would be edited to exclude it. */
    campaignId: number | null;
}

const EMPTY: LeadRejectionResult = { id: null, domain: null, campaignId: null };

/**
 * Record one rejection as evidence, and report what it was about.
 *
 * Returns the discovery provenance alongside the row id because the caller needs it for the
 * follow-up offer ("stop this search finding companies like this"), and resolving it here means
 * one query instead of the endpoint repeating the record → lead → campaign walk.
 *
 * Resolves to a result with `id: null` when the write was skipped or failed. Never rejects.
 */
export async function recordLeadRejection(db: Db, input: RecordLeadRejectionInput): Promise<LeadRejectionResult> {
    try {
        if (!Number.isInteger(input.organisationId) || !Number.isInteger(input.aiAssistantId)) {
            console.error('[lead-reject-feedback] missing organisationId/aiAssistantId, not recorded');
            return EMPTY;
        }
        // Refuse an unknown reason rather than writing a row nothing can group. The DB CHECK would
        // reject it anyway; catching it here means the log line names the value, which the
        // constraint error does not.
        if (!isLeadRejectReason(input.reason)) {
            console.error('[lead-reject-feedback] unknown reason, not recorded:', input.reason);
            return EMPTY;
        }
        const reason: LeadRejectReason = input.reason;

        // Provenance, when discovery produced this lead. A manually added record legitimately has
        // none — that is a real state, not a failed lookup, so it is not logged as one.
        const [lead] = await db
            .select({
                id: discoveredLeads.id,
                domain: discoveredLeads.domain,
                campaignId: discoveredLeads.campaignId,
            })
            .from(discoveredLeads)
            .where(and(
                eq(discoveredLeads.assistantRecordId, input.assistantRecordId),
                eq(discoveredLeads.organisationId, input.organisationId),
            ))
            .limit(1);

        const [row] = await db.insert(leadRejectFeedback).values({
            organisationId: input.organisationId,
            aiAssistantId: input.aiAssistantId,
            assistantRecordId: input.assistantRecordId,
            discoveredLeadId: lead?.id ?? null,
            campaignId: lead?.campaignId ?? null,
            reason,
            appliedToTarget: false,
        }).returning({ id: leadRejectFeedback.id });

        return {
            id: row?.id ?? null,
            domain: lead?.domain ?? null,
            campaignId: lead?.campaignId ?? null,
        };
    } catch (err) {
        // Name the constraint explicitly. postgres-js wraps the real failure and "Failed query"
        // alone tells you nothing — the same lesson recorded in revenue-ledger.ts.
        const pg = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
        console.error('[lead-reject-feedback] failed to record rejection', {
            organisationId: input.organisationId,
            assistantRecordId: input.assistantRecordId,
            reason: input.reason,
            pgCode: pg?.code,
            pgConstraint: pg?.constraint_name ?? pg?.constraint,
            cause: pg?.cause,
        }, err);
        return EMPTY;
    }
}
