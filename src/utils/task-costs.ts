// src/utils/task-costs.ts — what work costs in tasks, read from the database.
//
// Super admins set these in Admin → Revenue → Task costs (netlify/functions/admin-task-costs.ts). A
// cost is never overwritten: every change has a date, and the cost now is the newest item in force
// (db/z-task-costs.sql). So a change announced for next month starts by itself on its date.
//
// Read it on every path that charges or quotes a cost:   const costs = await getTaskCosts();
//
// ⚠️ Never throws, the same reason work-metering.ts fails open: a fault reading a price must not stop an
// assistant's work. It keeps the last figures it read and, with none (table not applied, or a cold start
// during a database fault), DEFAULT_TASK_COSTS, and logs that it did.

import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { DEFAULT_TASK_COSTS, isCostKey, type CostKey, type TaskCosts } from '../config/task-weights';

/** One item of a change that counts (baseline or announced). */
export interface CostRow {
    changeId: number;
    key: string;
    units: number;
    effectiveFrom: Date;
}

/** The cost in force for each key on a date: the newest item that has started. Pure. */
export function resolveTaskCosts(rows: readonly CostRow[], now: Date = new Date()): TaskCosts {
    const best = new Map<CostKey, CostRow>();
    for (const r of rows) {
        if (!isCostKey(r.key) || !Number.isInteger(r.units) || r.units < 0) continue;
        if (r.effectiveFrom.getTime() > now.getTime()) continue;
        const had = best.get(r.key);
        const newer = !had || r.effectiveFrom.getTime() > had.effectiveFrom.getTime()
            || (r.effectiveFrom.getTime() === had.effectiveFrom.getTime() && r.changeId > had.changeId);
        if (newer) best.set(r.key, r);
    }
    const out: TaskCosts = { ...DEFAULT_TASK_COSTS, weights: { ...DEFAULT_TASK_COSTS.weights } };
    for (const [key, r] of best) {
        if (key === 'ai_video_per_second') out.videoTasksPerSecond = r.units;
        // Zero would divide by nothing in the chat tally, whatever got into the table.
        else if (key === 'chat_messages_per_task') out.chatMessagesPerTask = Math.max(r.units, 1);
        else out.weights[key] = r.units;
    }
    return out;
}

const TTL_MS = 60_000;
let cache: { at: number; rows: CostRow[] } | null = null;
let inFlight: Promise<CostRow[] | null> | null = null;

/** Every item that counts. Null when it could not be read. */
async function readRows(): Promise<CostRow[] | null> {
    try {
        const rows = await getDb().execute<{ change_id: number; cost_key: string; new_units: number; effective_from: string }>(sql`
            SELECT i.change_id, i.cost_key, i.new_units, c.effective_from::text AS effective_from
              FROM task_cost_change_items i
              JOIN task_cost_changes c ON c.id = i.change_id
             WHERE c.status IN ('baseline', 'announced')`);
        return (rows as unknown as Array<{ change_id: number; cost_key: string; new_units: number; effective_from: string }>).map((r) => ({
            changeId: Number(r.change_id),
            key: r.cost_key,
            units: Number(r.new_units),
            // A naive timestamp is UTC here. Read as text so the local clock can't shift it.
            effectiveFrom: new Date(`${r.effective_from.replace(' ', 'T')}Z`),
        }));
    } catch (err) {
        console.error('[task-costs] could not read the costs; using the last known figures', err instanceof Error ? err.message : err);
        return null;
    }
}

/** The costs in force now. Cached for a minute per function instance. Never throws. */
export async function getTaskCosts(now: Date = new Date()): Promise<TaskCosts> {
    if (!cache || Date.now() - cache.at > TTL_MS) {
        inFlight ??= readRows().finally(() => { inFlight = null; });
        const rows = await inFlight;
        // A failed read keeps the last good figures, and tries again a minute later rather than on every charge.
        cache = { at: Date.now(), rows: rows ?? cache?.rows ?? [] };
    }
    return resolveTaskCosts(cache.rows, now);
}

/** After an admin changes something: this instance sees it at once, others within a minute. */
export function clearTaskCostCache(): void {
    cache = null;
}
