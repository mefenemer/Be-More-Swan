// netlify/functions/lead-retention-sweep.ts
// Move leads that have sat in Outreach for 30 days into the retained "Deleted" state.
// Daily cron (netlify.toml, 04:30 UTC — after archive-cleanup at 04:00, for no reason beyond
// keeping the destructive sweeps in one part of the night where they are easy to read in the logs).
//
// The rule, the window and the vocabulary all live in src/config/lead-retention.ts. This file is
// only the mechanism. Read that header first — in particular the paragraph on why this MOVES a
// lead rather than deleting it, which is the one thing about this job that is not obvious.
//
// ── What it collects ─────────────────────────────────────────────────────────
// Exactly the two Outreach columns the countdown is drawn on, and nothing else:
//   • approval_status = 'pending_approval'   (the Review column)
//   • approval_status = 'rejected'           (the Archived column)
// whose retention clock started more than LEAD_RETENTION_DAYS ago.
//
// ⚠️ 'approved' and 'scheduled' are deliberately absent, and must stay absent. A 'scheduled' lead
// is not a queued send — on this role that state IS the chase reminder for an email that has
// already gone to a real person (lead-generation.ts `send_outreach`). Sweeping it would delete the
// record of a conversation the user is in the middle of having. Every column the user can see a
// countdown on is swept; no column they cannot is.
//
// ── What it does NOT do ──────────────────────────────────────────────────────
// No row is deleted, here or downstream. `discovered_leads` is left completely alone: its
// `assistant_record_id` link stays intact (a hard delete is what severs it and orphans the
// provenance), and its own status stays whatever discovery last set. The only write is to
// `assistant_records.data.retention`.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { assistantRecords, adminAuditLog } from '../../db/schema';
import {
    LEAD_RETENTION_DAYS, RETENTION_FIELD, RETENTION_DELETED_SQL_PATH,
    retentionReasonFor, type RetentionReason,
} from '../../src/config/lead-retention';
import { resolveLeadRecipient } from '../../src/config/lead-recipient';
import { withLambda } from '@netlify/aws-lambda-compat';

/**
 * Rows collected per run.
 *
 * Matches archive-cleanup.ts. A backlog larger than this drains over successive nights rather than
 * in one transaction — the sweep is idempotent and the leads are not going anywhere, so a slow
 * drain is strictly better than a run that times out halfway and leaves the audit summary lying
 * about what it did.
 */
const BATCH_LIMIT = 500;

type Db = ReturnType<typeof getDb>;

interface Expired {
    id: number;
    organisationId: number;
    aiAssistantId: number;
    approvalStatus: string;
    data: unknown;
}

/**
 * The clock, in SQL: `updated_at`, and nothing else.
 *
 * Mirrors `retentionClockStart()` in the shared config, which the browser uses to draw the
 * countdown — a lead reading "4 days left" on screen must not be collected tonight. Both are now
 * the same single column read, which is the strongest guarantee of agreement available: there is
 * no expression here to drift from the one over there.
 *
 * Written as a `sql.raw` constant rather than inline so the SELECT and the ORDER BY below cannot
 * end up reading two different things.
 */
const clockSql = sql.raw('updated_at');

/** Already moved. Presence of `deletedAt` is the test — see isRetentionDeleted(). */
const notAlreadyDeleted = sql.raw(
    `NULLIF(BTRIM(data #>> '${RETENTION_DELETED_SQL_PATH}'), '') IS NULL`,
);

/**
 * Collect one batch of leads past their window.
 *
 * Ordered oldest-first so a backlog drains in the order it accumulated, and so two consecutive
 * runs cannot ping-pong over the same 500 rows while older ones wait.
 */
async function collect(db: Db, cutoff: Date): Promise<Expired[]> {
    return db
        .select({
            id: assistantRecords.id,
            organisationId: assistantRecords.organisationId,
            aiAssistantId: assistantRecords.aiAssistantId,
            approvalStatus: assistantRecords.approvalStatus,
            data: assistantRecords.data,
        })
        .from(assistantRecords)
        .where(and(
            eq(assistantRecords.recordType, 'lead'),
            or(
                eq(assistantRecords.approvalStatus, 'pending_approval'),
                eq(assistantRecords.approvalStatus, 'rejected'),
            ),
            sql`${clockSql} < ${cutoff}`,
            notAlreadyDeleted,
        ))
        .orderBy(sql`${clockSql} ASC`)
        .limit(BATCH_LIMIT);
}

/**
 * Stamp one lead as retained-deleted.
 *
 * ⚠️ jsonb_set on the `retention` key alone, never a wholesale rewrite of `data`. A lead's data
 * holds the scoring card, the outreach draft, the enrichment stamps and the deal outcome; reading
 * it in JS and writing it back would race every other writer of this row (the user editing the
 * draft in another tab, an enrichment pass landing an address) and silently discard whichever
 * write lost. The `|| jsonb_build_object(...)` form merges into whatever `retention` already
 * holds, so a restarted clock and a `returnedAt` stamp from an earlier send-back both survive.
 */
async function markDeleted(db: Db, ids: number[], reason: RetentionReason, at: Date): Promise<void> {
    if (!ids.length) return;
    await db.update(assistantRecords)
        .set({
            data: sql`jsonb_set(
                COALESCE(${assistantRecords.data}, '{}'::jsonb),
                '{${sql.raw(RETENTION_FIELD)}}',
                COALESCE(${assistantRecords.data} -> '${sql.raw(RETENTION_FIELD)}', '{}'::jsonb)
                    || jsonb_build_object('deletedAt', ${at.toISOString()}::text, 'reason', ${reason}::text),
                true
            )`,
            // The envelope is deliberately NOT touched. `approval_status` still says what the user
            // decided ('rejected') or failed to decide ('pending_approval'), and the Deleted
            // section shows that alongside the reason. Overwriting it would destroy the second
            // half of the story — "rejected, then dropped" and "never reviewed, then dropped" are
            // different facts and the targeting feedback wants both.
            updatedAt: at,
        })
        .where(inArray(assistantRecords.id, ids));
}

export default withLambda(async () => {
    const db = getDb();
    const now = new Date();
    const cutoff = new Date(now.getTime() - LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const expired = await collect(db, cutoff);
    if (!expired.length) {
        console.log('[lead-retention] nothing past its window');
        return { statusCode: 200, body: JSON.stringify({ moved: 0 }) };
    }

    // Group by reason so the update runs once per reason rather than once per lead. Resolving the
    // reason needs the record's data (doNotContact, enrichAttemptedAt) and its recipient, so it
    // happens here in JS — `retentionReasonFor` is the same function the API and the browser use,
    // and there is no SQL translation of it to drift from.
    const byReason = new Map<RetentionReason, number[]>();
    const byOrg: Record<string, number> = {};
    for (const row of expired) {
        const reason = retentionReasonFor(
            row.data,
            row.approvalStatus,
            resolveLeadRecipient(row.data) !== null,
        );
        const bucket = byReason.get(reason);
        if (bucket) bucket.push(row.id); else byReason.set(reason, [row.id]);
        const key = String(row.organisationId);
        byOrg[key] = (byOrg[key] ?? 0) + 1;
    }

    for (const [reason, ids] of byReason) {
        await markDeleted(db, ids, reason, now);
    }

    // Counts per reason, for the audit row and the logs. `enrichment_failed` climbing while the
    // others hold flat is a statement about the scraper, not about the users — it is the number
    // worth watching once on-demand enrichment ships.
    const perReason: Record<string, number> = {};
    for (const [reason, ids] of byReason) perReason[reason] = ids.length;

    await db.insert(adminAuditLog).values({
        adminId: null,
        action: 'lead_retention_sweep',
        targetType: 'assistant_records',
        targetId: null,
        newState: {
            retentionDays: LEAD_RETENTION_DAYS,
            movedCount: expired.length,
            movedByReason: perReason,
            movedByOrg: byOrg,
            // Says whether this run drained the backlog or merely took a bite out of it. A value
            // equal to BATCH_LIMIT on consecutive nights means the sweep is behind, which is
            // invisible from `movedCount` alone.
            batchLimit: BATCH_LIMIT,
            hitBatchLimit: expired.length === BATCH_LIMIT,
        },
    });

    console.log(`[lead-retention] moved ${expired.length} lead(s) to Deleted`, perReason);
    return { statusCode: 200, body: JSON.stringify({ moved: expired.length, byReason: perReason }) };
});
