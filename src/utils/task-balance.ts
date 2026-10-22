// src/utils/task-balance.ts
// How many tasks an organisation has used this month and how many it can still start — the ONE
// computation behind check-capacity.ts (the workspace's usage bar and upgrade prompts) and the
// assistants' chat (src/utils/chat-plan-snapshot.ts), so "how many tasks do I have left?" in chat
// can never disagree with the number on the page.
//
// The counter is usage_counters for the current UTC calendar month (atomic-cap-check.ts writes it).
// Bonus tasks (task_bonus) never expire and are spent after the allowance; AI media jobs still
// running have already been promised their tasks, so they are held back from what is left.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { usageCounters } from '../../db/schema';
import { getPeriodStart } from './atomic-cap-check';
import { TASK_WEIGHTS } from '../config/task-weights';

type Db = ReturnType<typeof getDb>;

export interface TaskUsage {
    taskCount: number;
    tokenCount: number;
    bonusTasks: number;
    tasksInFlight: number;
}

/** This month's usage for one organisation. Throws on a failed read — callers decide what that means. */
export async function readTaskUsage(db: Db, organisationId: number, periodStart: Date = getPeriodStart()): Promise<TaskUsage> {
    const [ucRow] = await db
        .select({ taskCount: usageCounters.taskCount, tokenCount: usageCounters.tokenCount })
        .from(usageCounters)
        .where(and(
            eq(usageCounters.organisationId, organisationId),
            eq(usageCounters.periodStart, periodStart),
        ))
        .limit(1);

    // Bonus tasks (non-expiring, spent after the allowance) and media jobs still running.
    // The weights are cast to int: an untyped parameter in SUM(CASE …) is text → 42883.
    const [extra] = await db.execute<{ bonus: number; in_flight: number }>(sql`
        SELECT COALESCE((SELECT bonus_tasks FROM task_bonus WHERE organisation_id = ${organisationId}), 0) AS bonus,
               COALESCE((SELECT SUM(CASE media_type WHEN 'video' THEN ${TASK_WEIGHTS.ai_video}::int WHEN 'audio' THEN ${TASK_WEIGHTS.ai_music}::int ELSE ${TASK_WEIGHTS.ai_image}::int END)
                           FROM media_generation_jobs
                          WHERE organisation_id = ${organisationId} AND status IN ('queued', 'processing')
                            AND created_at > now() - interval '2 hours'), 0) AS in_flight`) as unknown as Array<{ bonus: number; in_flight: number }>;

    return {
        // No counter row = nothing recorded this month.
        taskCount: ucRow?.taskCount ?? 0,
        tokenCount: ucRow?.tokenCount ?? 0,
        bonusTasks: Number(extra?.bonus ?? 0),
        tasksInFlight: Number(extra?.in_flight ?? 0),
    };
}

/** What can still be started: allowance left + bonus tasks − media jobs still running. null = uncapped. Pure. */
export function tasksRemaining(monthlyTaskLimit: number | null, u: Pick<TaskUsage, 'taskCount' | 'bonusTasks' | 'tasksInFlight'>): number | null {
    if (monthlyTaskLimit === null) return null;
    return Math.max(Math.max(monthlyTaskLimit - u.taskCount, 0) + u.bonusTasks - u.tasksInFlight, 0);
}

/** The first moment of next month, UTC — when the allowance resets. Pure. */
export function nextResetAt(now: Date = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
