// src/utils/site-audit-schedule.ts — the Mystery Shopper's weekly check. docs/mystery-shopper-plan.md §4.5.
//
// Called once a day: by netlify/functions/dispatch-site-audits.ts on Netlify's scheduler (production)
// and by run-site-audit-dispatch.ts from .github/workflows/staging-crons.yml (staging, where Netlify
// never fires schedules). It only QUEUES checks; each runs in run-site-audit-background.ts.
//
// WHICH AUDITS ARE DUE — decided by `isDue`, pure and tested:
//   · the assistant is switched on and working (not paused, not archived), and the audit is not paused;
//   · today, in UK time, is its check day — OR it has gone a week (CATCH_UP_DAYS) without a check
//     that completed or was still running. The catch-up is what makes a missed tick (a deploy at
//     06:30, GitHub dropping the staging cron) or a failed check cost a day rather than a week;
//   · and nothing has been checked today already (a re-poke the same day queues nothing).
//
// A queued weekly check is free when nothing changed (site-audit.ts runAuditCore) — so "check every
// week" costs a task only in a week something actually moved.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, siteAuditRuns, siteAudits } from '../../db/schema';
import { failAuditRun, requestAuditRun } from './site-audit';
import { triggerSiteAudit } from './trigger-site-audit';

type Db = ReturnType<typeof getDb>;

export const CHECK_TIMEZONE = 'Europe/London';
/** No check for this long and one is queued whatever the day — so a missed or failed check is retried tomorrow. */
export const CATCH_UP_DAYS = 7;
/** Most checks queued per tick — the rest wait for tomorrow's tick (they stay due). */
export const MAX_PER_TICK = 100;

/** The lifecycle states in which an assistant does its own work. */
const WORKING_STATES = ['ready_for_work', 'working'];

/** Day of week (0 = Sunday) and calendar date of an instant, in UK time. */
export function ukDay(at: Date): { weekday: number; date: string } {
    const date = at.toLocaleDateString('en-CA', { timeZone: CHECK_TIMEZONE });   // YYYY-MM-DD
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    return { weekday, date };
}

export interface DueInput {
    checkWeekday: number;
    /** When the last check of any kind was queued, or null if never. */
    lastCheckAt: Date | null;
}

export function isDue(a: DueInput, now: Date): boolean {
    const today = ukDay(now);
    if (a.lastCheckAt && ukDay(a.lastCheckAt).date === today.date) return false;   // already checked today
    if (a.checkWeekday === today.weekday) return true;
    if (!a.lastCheckAt) return true;   // set up but never checked (its first check failed to start)
    return now.getTime() - a.lastCheckAt.getTime() >= CATCH_UP_DAYS * 86_400_000;
}

/** The next day a weekly check will run, as YYYY-MM-DD in UK time — for the Calendar and the chat. */
export function nextCheckDate(a: DueInput, now: Date): string {
    const today = ukDay(now);
    const checkedToday = !!a.lastCheckAt && ukDay(a.lastCheckAt).date === today.date;
    let ahead = (a.checkWeekday - today.weekday + 7) % 7;
    if (ahead === 0 && checkedToday) ahead = 7;
    const d = new Date(`${today.date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + ahead);
    return d.toISOString().slice(0, 10);
}

/**
 * A raw-SQL timestamp, however the driver hands it over: postgres-js usually parses `timestamp`
 * into a Date, but a computed column can come back as text — read that as UTC, which is what every
 * timestamp in this schema holds. Exported for the test.
 */
export function asUtcDate(v: Date | string | null | undefined): Date | null {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    const s = String(v).trim().replace(' ', 'T');
    const d = new Date(/([zZ]|[+-]\d\d(:?\d\d)?)$/.test(s) ? s : `${s}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

export interface DispatchResult {
    considered: number;
    due: number;
    queued: number;
    alreadyRunning: number;
    failedToStart: number;
    deferred: number;
}

/** Queue today's checks. Never throws for one audit — each is counted, and the rest carry on. */
export async function dispatchDueSiteAudits(db: Db, now: Date = new Date()): Promise<DispatchResult> {
    const rows = await db.select({
        id: siteAudits.id,
        organisationId: siteAudits.organisationId,
        checkWeekday: siteAudits.checkWeekday,
        currentScore: siteAudits.currentScore,
        lastRunId: siteAudits.lastRunId,
        lastCheckAt: sql<Date | string | null>`(SELECT max(r.created_at) FROM ${siteAuditRuns} r WHERE r.audit_id = ${siteAudits.id} AND r.status <> 'failed')`,
    }).from(siteAudits)
        .innerJoin(aiAssistants, eq(aiAssistants.id, siteAudits.aiAssistantId))
        .where(and(
            inArray(siteAudits.status, ['active', 'goal_met']),
            eq(aiAssistants.isActive, true),
            inArray(aiAssistants.lifecycleStatus, WORKING_STATES),
        ));

    const out: DispatchResult = { considered: rows.length, due: 0, queued: 0, alreadyRunning: 0, failedToStart: 0, deferred: 0 };
    for (const r of rows) {
        const lastCheckAt = asUtcDate(r.lastCheckAt);
        if (!isDue({ checkWeekday: r.checkWeekday, lastCheckAt }, now)) continue;
        out.due++;
        if (out.queued + out.alreadyRunning >= MAX_PER_TICK) { out.deferred++; continue; }
        try {
            const kind = r.currentScore === null && r.lastRunId === null ? 'baseline' : 'weekly';
            const { runId, alreadyRunning } = await requestAuditRun(db, { auditId: r.id, organisationId: r.organisationId, kind, userId: null });
            if (alreadyRunning) { out.alreadyRunning++; continue; }
            if (await triggerSiteAudit(runId)) out.queued++;
            else {
                out.failedToStart++;
                await failAuditRun(db, runId, 'This week\'s check couldn\'t be started. It will be tried again tomorrow — nothing was charged.');
            }
        } catch (err) {
            out.failedToStart++;
            console.error('[site-audit-schedule] could not queue a check', { auditId: r.id, message: err instanceof Error ? err.message : String(err) });
        }
    }
    return out;
}
