// src/utils/site-audit-check-work.ts — "I'll work on this" on "Why your score isn't higher".
//
// The list is worked out afresh from each run's scores, so committing to a line has to live apart from
// it (db/z-mystery-shopper-check-work.sql). The tab and the chat card both reach it through
// site-audits.ts `check_work`; a later check that passes the line confirms it here. Done means the CHECK
// passed, not that some text went away, which is what makes this different from site_audit_fixes.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { siteAuditCheckWork } from '../../db/schema';
import type { CheckOutcome } from './site-score';

type Db = ReturnType<typeof getDb>;

export const CHECK_WORK_STATUSES = ['accepted', 'done', 'open'] as const;
export type CheckWorkStatus = (typeof CHECK_WORK_STATUSES)[number];

/** Said they'd work on it this long ago and it still isn't passing: Needs attention, as a stalled fix is. */
export const CHECK_WORK_STALLED_DAYS = 7;

/** Postgres: relation does not exist — db/z-mystery-shopper-check-work.sql not applied yet. */
export function isCheckWorkTableMissing(err: unknown): boolean {
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    return e?.code === '42P01' || e?.cause?.code === '42P01'
        || (/site_audit_(check_work|item_checks)/.test(`${e?.message} ${e?.cause?.message}`) && /does not exist/.test(`${e?.message} ${e?.cause?.message}`));
}

type Existing = { status: string; verifiedRunId: number | null } | null | undefined;

export type CheckWorkDecision =
    | { op: 'upsert'; status: 'accepted' | 'done' }
    | { op: 'delete' }
    | { op: 'none' }
    | { op: 'refuse'; statusCode: number; error: string };

/**
 * What a click means, given the row so far and this line in the latest check. A check's confirmation
 * stands, unless the line has failed again since: then it's a new piece of work.
 */
export function decideCheckWork(existing: Existing, status: CheckWorkStatus, outcome: CheckOutcome | undefined): CheckWorkDecision {
    const failing = outcome?.result === 'fail';
    const confirmed = !!existing && existing.verifiedRunId !== null;
    if (confirmed && !failing) {
        if (status === 'done') return { op: 'none' };
        return { op: 'refuse', statusCode: 409, error: 'A check has already confirmed this one.' };
    }
    if (status === 'open') return existing ? { op: 'delete' } : { op: 'none' };
    if (!existing && !failing) return { op: 'refuse', statusCode: 404, error: 'That isn\'t on the list from your last check.' };
    return { op: 'upsert', status };
}

/** The rows a run's outcomes prove: still open, or marked done by the user with no check behind it yet. */
export function checksNowPassing<T extends { id: number; checkId: string; status: string; verifiedRunId: number | null }>(
    work: T[], outcomes: Array<Pick<CheckOutcome, 'id' | 'result'>>,
): number[] {
    const passed = new Set(outcomes.filter((o) => o.result === 'pass').map((o) => o.id));
    return work.filter((w) => w.verifiedRunId === null && passed.has(w.checkId)).map((w) => w.id);
}

/**
 * Called once a run has latched as done. Best-effort: a missing table or a database blip must not
 * fail a check the customer has already been charged for, and the next check tries again.
 */
export async function confirmPassedChecks(db: Db, auditId: number, pageUrl: string, runId: number, outcomes: CheckOutcome[]): Promise<void> {
    try {
        const work = await db.select({
            id: siteAuditCheckWork.id, checkId: siteAuditCheckWork.checkId,
            status: siteAuditCheckWork.status, verifiedRunId: siteAuditCheckWork.verifiedRunId,
        }).from(siteAuditCheckWork).where(and(
            eq(siteAuditCheckWork.auditId, auditId),
            eq(siteAuditCheckWork.pageUrl, pageUrl),
            sql`${siteAuditCheckWork.verifiedRunId} IS NULL`,
        ));
        const ids = checksNowPassing(work, outcomes);
        if (ids.length) {
            await db.update(siteAuditCheckWork)
                .set({ status: 'done', verifiedRunId: runId, updatedAt: new Date() })
                .where(inArray(siteAuditCheckWork.id, ids));
        }
    } catch (err) {
        if (!isCheckWorkTableMissing(err)) console.error('[site-audit] confirming checks failed', err instanceof Error ? err.message : err);
    }
}

// ── "Check if this is done" ─────────────────────────────────────────────────────────────────────

export const ITEM_KINDS = ['fix', 'check'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export type ItemVerdict = 'checking' | 'not_checked' | 'incomplete' | 'nothing_changed' | null;

/**
 * What the check they asked for says about an item STILL in progress (a finished one has left the
 * list for Done). Read from the run, never stored, so a failed or swept run can't strand an item.
 * 'unchanged' re-read the page and found it identical: the item can't have been done, and it was free.
 */
export function itemVerdict(runStatus: string | null | undefined): ItemVerdict {
    if (runStatus === 'queued' || runStatus === 'running') return 'checking';
    if (runStatus === 'failed' || runStatus === 'unreadable') return 'not_checked';
    if (runStatus === 'done') return 'incomplete';
    if (runStatus === 'unchanged') return 'nothing_changed';
    return null;
}

const quote = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The brief typed into the Website Assistant's chat. Built from the server's rows, and never sent for
 * them. A placeholder stays a placeholder: the Website Assistant must not invent the real detail.
 */
export function websiteChangeBrief(item:
    | { kind: 'fix'; location: string | null; beforeText: string; afterText: string }
    | { kind: 'check'; label: string },
): string {
    const ask = item.kind === 'fix'
        ? `please change "${quote(item.beforeText)}"${item.location ? ` (${quote(item.location)})` : ''} to "${quote(item.afterText)}".`
        : `it says this is missing: "${quote(item.label)}". Please change the site so that's no longer true.`;
    return `From my Mystery Shopper's website check: ${ask} Use only real details from my site and business information, and ask me for anything you don't have rather than making it up.`;
}
