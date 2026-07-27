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

interface AtomicCapCheckResult {
    allowed: boolean;
    /** Current counter value after the operation (only reliable when allowed=true) */
    newValue?: number;
    /** Human-readable rejection reason for the 429 response body */
    limitMessage?: string;
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
        return { allowed: false, limitMessage: 'Cap enforcement error. Please try again.' };
    }

    const db         = getDb();
    const col        = COLUMN_MAP[counterKey];
    const periodStart = getPeriodStart();

    for (let attempt = 0; attempt < 2; attempt++) {
        // Single atomic UPDATE: only succeeds when current value + increment <= limit
        const result = await db.execute(sql`
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

        const row = result[0] as any;
        if (row) {
            return { allowed: true, newValue: row.new_value };
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
    return { allowed: false, limitMessage: 'Cap enforcement error. Please try again.' };
}

/** Returns the first day of the current UTC calendar month as a Date */
export function getPeriodStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
