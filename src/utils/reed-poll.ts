// src/utils/reed-poll.ts
// Buying triggers Phase 5, ADMIN ONLY (docs/buying-triggers-plan.md §5; owner 2026-11-17): the daily read of
// local businesses hiring, from Reed (src/lib/triggers/reed-jobs.ts), into trigger_events with source
// 'reed_jobs', matched to Companies House by the same code as the FSA feed. Shown on Admin ▸ Buying triggers
// ▸ Hiring. Nothing reaches a workspace.
//
// Same rules as the FSA feed (trigger-engine.ts):
//   - The first read of each role + place is SILENT: every job already advertised is recorded as seen.
//   - A job seen for the first time is news only if it was posted in the last REED_FRESH_DAYS days (an old
//     advert that moved into the results is not "just started hiring").
//   - A role + place that fails is skipped for the day, never half-read; the rest carry on.
//   - Recruitment agencies are left out (postedByDirectEmployer + a name check).
// Runs inside run-trigger-poll-background.ts after the FSA read.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    REED_SOURCE, REED_GAP_MS, fetchReedJobs, isFreshPosting, isReedConfigured, isReedSourceEnabled, looksLikeAgency,
    queryKey, reedDate, reedQueries, reedToEvent, type ReedJob,
} from '../lib/triggers/reed-jobs';
import type { TriggerEvent } from '../lib/triggers/types';
import { EVENT_KEEP_DAYS, SEEN_KEEP_DAYS, checkCompanies, insertEvents, markSeen, ukDay } from './trigger-engine';

type Db = ReturnType<typeof getDb>;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface ReedPollResult {
    ok: boolean;
    skipped?: string;
    queries?: number;
    queriesRead?: number;
    baselinedQueries?: number;
    jobsListed?: number;
    agenciesSkipped?: number;
    oldAdverts?: number;
    newEvents?: number;
    failedQueries?: string[];
    companyChecks?: Awaited<ReturnType<typeof checkCompanies>>;
    durationMs?: number;
    error?: string;
}

/**
 * What one role + place read means, given what was already seen. Pure (tests/reed-jobs.test.ts).
 * Not baselined yet → nothing is news. Otherwise: new, fresh, non-agency jobs are events.
 */
export function planReedQuery(jobs: ReedJob[], seen: Set<string>, baselined: boolean, today: string): {
    direct: ReedJob[]; agencies: number; fresh: ReedJob[]; old: number;
} {
    const direct = jobs.filter((j) => !looksLikeAgency(j.employerName));
    const agencies = jobs.length - direct.length;
    if (!baselined) return { direct, agencies, fresh: [], old: 0 };
    const unseen = direct.filter((j) => !seen.has(String(j.jobId)));
    const fresh = unseen.filter((j) => isFreshPosting(reedDate(j.date), today));
    return { direct, agencies, fresh, old: unseen.length - fresh.length };
}

export async function runReedPoll(db: Db, opts: { deadline: number; now?: Date; maxCompanyChecks?: number }): Promise<ReedPollResult> {
    const started = Date.now();
    if (!isReedSourceEnabled()) return { ok: true, skipped: 'switched_off' };
    if (!isReedConfigured()) return { ok: true, skipped: 'no_api_key' };
    const today = ukDay(opts.now ?? new Date());

    await db.execute(sql`INSERT INTO trigger_sources (source) VALUES (${REED_SOURCE}) ON CONFLICT (source) DO NOTHING`);
    const [row] = await db.execute(sql`SELECT last_result -> 'state' AS state FROM trigger_sources WHERE source = ${REED_SOURCE}`) as Array<{ state: unknown }>;
    const st = (row?.state && typeof row.state === 'object') ? row.state as { queries?: Record<string, string> } : {};
    const baselinedAt: Record<string, string> = { ...(st.queries || {}) };
    const seenRows = await db.execute(sql`SELECT subject_id FROM trigger_seen WHERE source = ${REED_SOURCE}`) as Array<{ subject_id: string }>;
    const seen = new Set(seenRows.map((r) => r.subject_id));

    const queries = reedQueries();
    const out: ReedPollResult = { ok: true, queries: queries.length, queriesRead: 0, baselinedQueries: 0, jobsListed: 0, agenciesSkipped: 0, oldAdverts: 0, newEvents: 0, failedQueries: [] };
    const pending: TriggerEvent[] = [];
    const employerCount = new Map<string, number>();
    const freshJobs: Array<{ job: ReedJob; q: (typeof queries)[number] }> = [];

    for (const q of queries) {
        if (Date.now() > opts.deadline) { out.failedQueries!.push(`${queryKey(q)} (out of time)`); continue; }
        let jobs: ReedJob[];
        try {
            jobs = await fetchReedJobs(q);
        } catch (err) {
            out.failedQueries!.push(`${queryKey(q)} (${err instanceof Error ? err.message : 'failed'})`);
            await sleep(REED_GAP_MS);
            continue;
        }
        out.queriesRead!++;
        const key = queryKey(q);
        const baselined = !!baselinedAt[key];
        const plan = planReedQuery(jobs, seen, baselined, today);
        out.jobsListed! += plan.direct.length;
        out.agenciesSkipped! += plan.agencies;
        out.oldAdverts! += plan.old;
        for (const j of plan.direct) {
            const emp = String(j.employerId ?? j.employerName ?? '');
            employerCount.set(emp, (employerCount.get(emp) ?? 0) + 1);
        }
        for (const j of plan.fresh) freshJobs.push({ job: j, q });
        // Everything listed is now seen (the first read silently, as the baseline).
        await markSeen(db, plan.direct.map((j) => ({ id: String(j.jobId), baseline: !baselined })), REED_SOURCE);
        for (const j of plan.direct) seen.add(String(j.jobId));
        if (!baselined) { baselinedAt[key] = new Date().toISOString(); out.baselinedQueries!++; }
        await sleep(REED_GAP_MS);
    }

    const already = new Set<string>();
    for (const { job, q } of freshJobs) {
        if (already.has(String(job.jobId))) continue;
        already.add(String(job.jobId));
        pending.push(reedToEvent(job, q, today, employerCount.get(String(job.employerId ?? job.employerName ?? '')) ?? 1));
    }
    out.newEvents = await insertEvents(db, pending);

    out.companyChecks = await checkCompanies(db, opts.deadline, opts.maxCompanyChecks ?? 300, REED_SOURCE);

    await db.execute(sql`DELETE FROM trigger_events WHERE source = ${REED_SOURCE} AND first_seen_at < now() - make_interval(days => ${EVENT_KEEP_DAYS})`);
    await db.execute(sql`DELETE FROM trigger_seen WHERE source = ${REED_SOURCE} AND last_seen_at < now() - make_interval(days => ${SEEN_KEEP_DAYS})`);

    out.durationMs = Date.now() - started;
    const allBaselined = queries.every((q) => baselinedAt[queryKey(q)]);
    await db.execute(sql`
        UPDATE trigger_sources SET last_run_at = now(),
               last_ok_at = CASE WHEN ${out.queriesRead! > 0} THEN now() ELSE last_ok_at END,
               baseline_done_at = CASE WHEN ${allBaselined} THEN COALESCE(baseline_done_at, now()) ELSE baseline_done_at END,
               last_result = ${JSON.stringify({ ...out, state: { queries: baselinedAt } })}::jsonb,
               updated_at = now()
         WHERE source = ${REED_SOURCE}`);
    return out;
}
