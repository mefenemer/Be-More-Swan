// src/utils/work-metering.ts
// Background work counts against the monthly task allowance — one task per finished piece of work.
//
// Until 2026-10-11 only chat turns and six post-editor buttons spent tasks (src/utils/task-credit.ts).
// Everything an assistant did ON ITS OWN — drafting social posts and blog articles, running lead
// searches, drafting email issues and campaign sequences — was free, so the "tasks per month" the
// pricing page sells measured almost none of the work. This module meters that work.
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
// request is refused against it.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { getPeriodStart } from './atomic-cap-check';
import { resolveTaskLimit } from './task-credit';

type Db = ReturnType<typeof getDb>;

/** What one task bought — logged with every charge so a disputed count can be explained. */
export type WorkKind = 'social_post' | 'blog_article' | 'lead_search' | 'email_issue' | 'email_campaign' | 'site_audit';

/** The message stored on a job refused at the cap, and shown wherever the job's error is. */
export const TASK_LIMIT_MESSAGE = 'Your monthly task allowance is used up, so this was not started. It resets on the 1st of the month.';

/** Does this org have at least one task left this month? Never throws; fails open. */
export async function hasTaskCapacity(db: Db, organisationId: number): Promise<boolean> {
    try {
        const plan = await resolveTaskLimit(db, organisationId);
        if (!plan.hasPlan || plan.limit === null) return true;
        const rows = await db.execute<{ task_count: number }>(sql`
            SELECT task_count FROM usage_counters
             WHERE organisation_id = ${organisationId} AND period_start = ${getPeriodStart().toISOString()}
             LIMIT 1`);
        const used = Number((rows as unknown as Array<{ task_count: number }>)[0]?.task_count ?? 0);
        return used < plan.limit;
    } catch (err) {
        console.error('[work-metering] capacity check failed — allowing the work (fail open)', {
            organisationId, message: err instanceof Error ? err.message : String(err),
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

/** Count finished work. Never throws — the work is already delivered and must not be undone by this. */
export async function recordCompletedWork(
    db: Db,
    organisationId: number,
    kind: WorkKind,
    units = 1,
    ref?: string | number,
): Promise<void> {
    if (!Number.isInteger(units) || units <= 0) return;
    try {
        await db.execute(sql`
            INSERT INTO usage_counters (organisation_id, period_start, task_count)
            VALUES (${organisationId}, ${getPeriodStart().toISOString()}, ${units})
            ON CONFLICT (organisation_id, period_start)
            DO UPDATE SET task_count = usage_counters.task_count + ${units}, updated_at = now()`);
    } catch (err) {
        console.error('[work-metering] could not record completed work', {
            organisationId, kind, units, ref, message: err instanceof Error ? err.message : String(err),
        });
    }
}
