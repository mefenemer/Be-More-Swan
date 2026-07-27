// src/utils/atomic-cap-check.ts
// US-DB-1.4.1: Atomic cap enforcement utility.
//
// Uses a single UPDATE to increment the counter only when below the cap —
// eliminates the check-then-insert race condition present in the old COUNT(*) pattern.
//
// Usage:
//   const result = await atomicCapCheck({ organisationId, counterKey: 'taskCount', limit: monthlyTaskLimit });
//   if (!result.allowed) return { statusCode: 429, body: ... };

import { getDb } from '../../db/client';
import { usageCounters } from '../../db/schema';
import { and, eq, sql } from 'drizzle-orm';

export type CounterKey = 'taskCount' | 'tokenCount' | 'assistantCount' | 'connectionCount';

const COLUMN_MAP: Record<CounterKey, string> = {
    taskCount:       'task_count',
    tokenCount:      'token_count',
    assistantCount:  'assistant_count',
    connectionCount: 'connection_count',
};

interface AtomicCapCheckParams {
    organisationId: number;
    counterKey: CounterKey;
    /** null = unlimited */
    limit: number | null;
    /** Amount to increment (default 1) */
    increment?: number;
}

export interface AtomicCapCheckResult {
    allowed: boolean;
    /** Current counter value after the operation (only reliable when allowed=true) */
    newValue?: number;
    /** Human-readable rejection reason for the 429 response body */
    limitMessage?: string;
    /**
     * The check could not be EVALUATED — a server fault, not a plan limit.
     *
     * Both cases are `allowed: false`, and callers must not conflate them: the paywall/upgrade
     * response is a lie when the truth is "the database did not answer". Nothing about the user's
     * plan is wrong, and telling them to upgrade to fix a transient fault is worse than saying
     * nothing at all.
     */
    failed?: boolean;
}

/**
 * Atomically checks the cap and increments the counter in one UPDATE.
 * If the row doesn't exist for this period, it is upserted with 0 and the UPDATE retried once.
 */
export async function atomicCapCheck(params: AtomicCapCheckParams): Promise<AtomicCapCheckResult> {
    const { organisationId, counterKey, limit, increment = 1 } = params;

    // Unlimited plan — skip DB entirely
    if (limit === null) return { allowed: true };

    // Both of these are interpolated straight into the SQL below as parameters and compared against
    // integer columns. A non-integer (a string out of the plans.featureOverrides jsonb, a NaN from a
    // bad parse) does not fail the CHECK — it fails the QUERY, and the caller surfaces a raw
    // "Failed query: UPDATE usage_counters ..." to the user. Refuse the input here instead, where it
    // can be logged and turned into an ordinary denial.
    if (!Number.isInteger(limit) || !Number.isInteger(increment)) {
        console.error('[atomicCapCheck] non-integer cap input', { organisationId, counterKey, limit, increment });
        return { allowed: false, failed: true, limitMessage: 'Cap enforcement error. Please try again.' };
    }

    const db         = getDb();
    const col        = COLUMN_MAP[counterKey];
    const periodStart = getPeriodStart();

    for (let attempt = 0; attempt < 2; attempt++) {
        // Single atomic UPDATE: only succeeds when current value + increment <= limit
        let result;
        try {
            result = await db.execute(sql`
                UPDATE usage_counters
                SET
                    ${sql.raw(col)} = ${sql.raw(col)} + ${increment},
                    updated_at = now()
                WHERE
                    organisation_id = ${organisationId}
                    AND period_start = ${periodStart}
                    AND ${sql.raw(col)} + ${increment} <= ${limit}
                RETURNING ${sql.raw(col)} AS new_value
            `);
        } catch (err) {
            // A cap check that THROWS is not a denial, and it must not be reported as one thing or
            // the other by accident. Two separate failures were happening here at once:
            //
            //   1. drizzle's postgres-js wrapper throws `Failed query: UPDATE usage_counters ...`,
            //      and every caller (chat-orchestrator among them) put that straight into the
            //      response — so users were shown raw SQL and a 500 for what is a server fault.
            //   2. the ACTUAL Postgres error — the code, detail and hint that say WHY — lives on
            //      `err.cause` and was never logged anywhere, which is why this has been diagnosed
            //      twice from the SQL string alone and got it wrong both times.
            //
            // Log the cause, return an ordinary denial. Fail closed: a cap that cannot be evaluated
            // must not wave the request through.
            const cause = (err as { cause?: Record<string, unknown> })?.cause ?? {};
            console.error('[atomicCapCheck] cap UPDATE failed', {
                organisationId, counterKey, limit, increment, periodStart: periodStart.toISOString(),
                message: err instanceof Error ? err.message : String(err),
                pgCode: cause.code, pgDetail: cause.detail, pgHint: cause.hint,
                pgColumn: cause.column_name, pgTable: cause.table_name, pgRoutine: cause.routine,
            });
            return { allowed: false, failed: true, limitMessage: 'We could not check your plan usage just now. Please try again.' };
        }

        const row = (result as unknown as Array<Record<string, unknown>>)[0];
        if (row) {
            // RETURNING gives back an integer column, but it arrives untyped through db.execute.
            return { allowed: true, newValue: Number(row.new_value) };
        }

        // Row missing or cap exceeded — distinguish the two cases
        const existing = await db
            .select({ value: sql<number>`${sql.raw(col)}` })
            .from(usageCounters)
            .where(and(
                eq(usageCounters.organisationId, organisationId),
                eq(usageCounters.periodStart, periodStart),
            ))
            .limit(1);

        if (existing.length > 0) {
            // Row exists but cap would be exceeded
            const labelMap: Record<CounterKey, string> = {
                taskCount:       'Monthly task limit',
                tokenCount:      'Monthly token limit',
                assistantCount:  'Assistant limit',
                connectionCount: 'Connection limit',
            };
            return {
                allowed: false,
                limitMessage: `${labelMap[counterKey]} reached for your plan. Upgrade to continue.`,
            };
        }

        // Row doesn't exist yet — upsert it with 0 and retry the UPDATE
        await db
            .insert(usageCounters)
            .values({ organisationId, periodStart, [counterKey]: 0 })
            .onConflictDoNothing();
        // Loop once more to retry the UPDATE
    }

    // Should not be reached, but fail-closed
    return { allowed: false, failed: true, limitMessage: 'Cap enforcement error. Please try again.' };
}

/** Returns the first day of the current UTC calendar month as a Date */
export function getPeriodStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
