// src/utils/work-metering.ts
// Finished work counts against the monthly task allowance — see docs/task-metering.md.
//
// Until 2026-10-11 only chat turns and six post-editor buttons spent tasks (src/utils/task-credit.ts).
// Everything an assistant did ON ITS OWN — drafting social posts and blog articles, running lead
// searches, drafting email issues and campaign sequences — was free, so the "tasks per month" the
// pricing page sells measured almost none of the work. This module meters that work.
//
// One allowance (from the 2026-12 cutover, flag 'unified_task_metering'): a task is one finished
// piece of work, weighted by src/config/task-weights.ts — an AI video is 20, an X link post 10.
// Chat and editing helpers cost no tasks (src/utils/fair-use.ts). AI media credits and X credits
// are retired; their balances became bonus tasks (task_bonus), which never expire and are spent
// only once the monthly allowance is used up.
//
// Two halves, deliberately split:
//   • hasTaskCapacity — asked BEFORE the work starts. At the cap the work is refused (the cap is a
//     hard stop, never an overage charge — [task cap is a hard stop]).
//   • recordCompletedWork — called only once the work has been DELIVERED. Charging on success, not
//     at the start, means a provider outage, a retry or a parked job never costs the customer a task.
//
// ⚠️ Both fail OPEN, the opposite of chat's consumeTaskCredit. A metering fault must never be the
// thing that stops an assistant's scheduled work — the drafting crons have a history of failing
// silently for days (see the content-jobs comments), and a refusal here looks exactly like one.
// The same goes for an org with no plan row: a paying customer can lack one (see the billing notes),
// and stopping their drafting on that basis would be worse than not counting it.
//
// The record is an unconditional increment, so in-flight work finishing after the cap can carry the
// count slightly past the limit. That is the honest number — the work was done — and every later
// request is refused against it. Media jobs still running are counted as already used by the
// capacity check, so five videos started at once cannot all squeeze through the last 20 tasks.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { TASK_WEIGHTS, AI_VIDEO_TASKS_PER_SECOND, videoPricedBySecond, type WorkKind } from '../config/task-weights';
import { getPeriodStart } from './atomic-cap-check';
import { resolveTaskLimit } from './task-credit';

export type { WorkKind } from '../config/task-weights';

type Db = ReturnType<typeof getDb>;

/** The message stored on a job refused at the cap, and shown wherever the job's error is. */
export const TASK_LIMIT_MESSAGE = 'Your monthly task allowance is used up, so this was not started. It resets on the 1st of the month.';

/** Tasks a running media job will cost once it finishes, by media_generation_jobs.media_type.
 *  ⚠️ Every weight is CAST: a bound parameter inside SUM(CASE …) has no type of its own, Postgres
 *  reads it as text, and SUM(text) does not exist (42883) — which made every capacity read throw. */
export const inFlightWeightSql = () => sql`CASE media_type WHEN 'video' THEN ${inFlightVideoSql()} WHEN 'audio' THEN ${TASK_WEIGHTS.ai_music}::int ELSE ${TASK_WEIGHTS.ai_image}::int END`;

/** A running clip's tasks: by its billed length when AI video is priced by the second (aiVideoTasks). */
function inFlightVideoSql() {
    return videoPricedBySecond()
        ? sql`(CEIL(COALESCE(duration_seconds, 6))::int * ${AI_VIDEO_TASKS_PER_SECOND}::int)`
        : sql`${TASK_WEIGHTS.ai_video}::int`;
}

export interface TaskUsage {
    hasPlan: boolean;
    /** Monthly allowance; null = an uncapped paid tier. */
    limit: number | null;
    /** Tasks recorded this month (may exceed limit once bonus tasks are being spent). */
    used: number;
    /** Non-expiring bonus tasks still available. */
    bonus: number;
    /** Tasks reserved by media jobs still running. */
    inFlight: number;
    /** What can still be started: allowance left + bonus − in flight. null = uncapped. */
    remaining: number | null;
}

/**
 * The org's task position this month. Throws on a DB fault — callers that must fail open
 * (hasTaskCapacity) catch it; read-only displays (check-capacity) report it.
 */
export async function getTaskUsage(db: Db, organisationId: number): Promise<TaskUsage> {
    const plan = await resolveTaskLimit(db, organisationId);
    const period = getPeriodStart().toISOString();
    const rows = await db.execute<{ used: number; bonus: number; in_flight: number }>(sql`
        SELECT
          COALESCE((SELECT task_count FROM usage_counters
                     WHERE organisation_id = ${organisationId} AND period_start = ${period} LIMIT 1), 0) AS used,
          COALESCE((SELECT bonus_tasks FROM task_bonus WHERE organisation_id = ${organisationId}), 0) AS bonus,
          COALESCE((SELECT SUM(${inFlightWeightSql()}) FROM media_generation_jobs
                     WHERE organisation_id = ${organisationId}
                       AND status IN ('queued', 'processing')
                       -- A job stuck for hours is dead, not in flight; don't let it block the org.
                       AND created_at > now() - interval '2 hours'), 0) AS in_flight`);
    const row = (rows as unknown as Array<{ used: number; bonus: number; in_flight: number }>)[0];
    const used = Number(row?.used ?? 0);
    const bonus = Number(row?.bonus ?? 0);
    const inFlight = Number(row?.in_flight ?? 0);
    const remaining = plan.limit === null
        ? null
        : Math.max(plan.limit - used, 0) + bonus - inFlight;
    return { hasPlan: plan.hasPlan, limit: plan.limit, used, bonus, inFlight, remaining };
}

/**
 * Can this org start work costing `units` tasks? Never throws; fails open.
 * Pass the work's weight for anything heavier than 1 (taskWeight('ai_video')).
 */
export async function hasTaskCapacity(db: Db, organisationId: number, units = 1): Promise<boolean> {
    try {
        const usage = await getTaskUsage(db, organisationId);
        if (!usage.hasPlan || usage.remaining === null) return true;
        return usage.remaining >= units;
    } catch (err) {
        console.error('[work-metering] capacity check failed — allowing the work (fail open)', {
            organisationId, units, message: err instanceof Error ? err.message : String(err),
        });
        return true;
    }
}

/**
 * Per-run memo for loops that ask once per assistant: an org with five assistants is looked up once,
 * and a refusal for one of them is a refusal for all.
 */
export function capacityMemo(db: Db): (organisationId: number) => Promise<boolean> {
    const seen = new Map<number, Promise<boolean>>();
    return (organisationId) => {
        if (!seen.has(organisationId)) seen.set(organisationId, hasTaskCapacity(db, organisationId));
        return seen.get(organisationId)!;
    };
}

export interface RecordWorkOptions {
    /** Override the weight (e.g. several items in one charge). Defaults to TASK_WEIGHTS[kind]. */
    units?: number;
    ref?: string | number;
    assistantId?: number | null;
}

/**
 * Count finished work. Never throws — the work is already delivered and must not be undone by this.
 *
 * One statement bumps usage_counters.task_count, spends bonus tasks for whatever part of the charge
 * falls past the monthly allowance, and writes the task_ledger row that itemises it.
 *
 * The positional (units, ref) form is the pre-weighting signature, kept for the existing callers.
 */
export async function recordCompletedWork(
    db: Db,
    organisationId: number,
    kind: WorkKind,
    unitsOrOpts?: number | RecordWorkOptions,
    ref?: string | number,
): Promise<void> {
    const opts: RecordWorkOptions = typeof unitsOrOpts === 'object' && unitsOrOpts !== null
        ? unitsOrOpts
        : { units: unitsOrOpts, ref };
    const units = opts.units ?? TASK_WEIGHTS[kind];
    if (!Number.isInteger(units) || units <= 0) return;

    let limit: number | null = null;
    try {
        limit = (await resolveTaskLimit(db, organisationId)).limit;
    } catch {
        // Without the limit we cannot tell what part came from bonus tasks; count the work anyway.
        limit = null;
    }
    // A non-integer limit out of a featureOverrides snapshot must not reach the SQL (see
    // atomic-cap-check.ts); treat it as "unknown" and spend no bonus.
    const limitParam = limit !== null && Number.isInteger(limit) ? limit : null;
    const period = getPeriodStart().toISOString();
    const refText = opts.ref === undefined || opts.ref === null ? null : String(opts.ref);

    try {
        await db.execute(sql`
            WITH counter AS (
                INSERT INTO usage_counters (organisation_id, period_start, task_count)
                VALUES (${organisationId}, ${period}, ${units})
                ON CONFLICT (organisation_id, period_start)
                DO UPDATE SET task_count = usage_counters.task_count + ${units}, updated_at = now()
                RETURNING task_count
            ),
            -- The part of this charge past the allowance: none while under it, all of it once over.
            overflow AS (
                SELECT CASE WHEN ${limitParam}::int IS NULL THEN 0
                            ELSE LEAST(${units}, GREATEST(task_count - ${limitParam}::int, 0)) END AS want
                  FROM counter
            ),
            -- RETURNING sees the NEW balance; the self-join (prev) supplies the old one so the
            -- ledger can say how much was taken. Two concurrent overflowing charges serialise on the
            -- row lock and the balance stays exact; only the second ledger's bonus_units can read a
            -- stale prev and overstate — an audit nicety, not money.
            spent AS (
                UPDATE task_bonus b
                   SET bonus_tasks = b.bonus_tasks - LEAST(b.bonus_tasks, o.want), updated_at = now()
                  FROM overflow o, task_bonus prev
                 WHERE b.organisation_id = ${organisationId} AND prev.organisation_id = b.organisation_id AND o.want > 0
             RETURNING LEAST(prev.bonus_tasks, o.want) AS took
            )
            INSERT INTO task_ledger (organisation_id, period_start, kind, units, bonus_units, source, assistant_id, ref)
            SELECT ${organisationId}, ${period}, ${kind}, ${units},
                   COALESCE((SELECT took FROM spent), 0), 'work', ${opts.assistantId ?? null}, ${refText}`);
    } catch (err) {
        console.error('[work-metering] could not record completed work', {
            organisationId, kind, units, ref: refText, message: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Add (or, with a negative amount, remove) bonus tasks — the cutover conversion, an admin
 * adjustment, or a purchased pack. Floors at zero. Throws on failure: callers are admin tools and
 * webhooks that must report it.
 */
export async function grantBonusTasks(
    db: Db,
    organisationId: number,
    amount: number,
    source: 'conversion' | 'admin' | 'purchase',
    opts: { userId?: number | null; note?: string; ref?: string } = {},
): Promise<number> {
    if (!Number.isInteger(amount) || amount === 0) throw new Error('grantBonusTasks: amount must be a non-zero integer');
    const period = getPeriodStart().toISOString();
    const rows = await db.execute<{ bonus_tasks: number }>(sql`
        WITH upd AS (
            INSERT INTO task_bonus (organisation_id, bonus_tasks)
            VALUES (${organisationId}, GREATEST(${amount}, 0))
            ON CONFLICT (organisation_id)
            DO UPDATE SET bonus_tasks = GREATEST(task_bonus.bonus_tasks + ${amount}, 0), updated_at = now()
            RETURNING bonus_tasks
        ), led AS (
            INSERT INTO task_ledger (organisation_id, period_start, kind, units, source, user_id, ref, note)
            VALUES (${organisationId}, ${period}, 'bonus_grant', ${amount}, ${source}, ${opts.userId ?? null}, ${opts.ref ?? null}, ${opts.note ?? null})
        )
        SELECT bonus_tasks FROM upd`);
    return Number((rows as unknown as Array<{ bonus_tasks: number }>)[0]?.bonus_tasks ?? 0);
}
