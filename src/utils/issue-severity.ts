// src/utils/issue-severity.ts — how bad an issue is, and who needs to hear now (2026-11-12).
//
// The reporter picks it in Contact us ("How bad is it?"); an admin can change it on the issue.
// Stored in issue_reports.severity (db/z-issue-severity.sql) — read and written raw behind
// severityColumnReady(), like the incident and live-check columns, so "Report an issue" keeps
// working on a database the SQL hasn't reached.
//
// A critical or high issue from a PAYING workspace (org-plan-value.ts) gets an alert email to the
// business inbox straight away, with the plan and its monthly value in the subject.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

export const ISSUE_SEVERITIES = ['critical', 'high', 'normal', 'low'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];
export const ISSUE_SEVERITY_LABEL: Record<IssueSeverity, string> = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' };

export function isIssueSeverity(v: unknown): v is IssueSeverity {
    return typeof v === 'string' && (ISSUE_SEVERITIES as readonly string[]).includes(v);
}

/** Should this new issue page someone now? Paying workspace AND critical/high. */
export function needsPayingAlert(severity: string | null | undefined, paying: boolean): boolean {
    return paying && (severity === 'critical' || severity === 'high');
}

let readyCache: { ready: boolean; at: number } | null = null;
export async function severityColumnReady(db: Db): Promise<boolean> {
    if (readyCache && (readyCache.ready || Date.now() - readyCache.at < 5 * 60_000)) return readyCache.ready;
    try {
        const rows = await db.execute(sql`
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'issue_reports' AND column_name = 'severity' LIMIT 1`) as unknown[];
        readyCache = { ready: rows.length > 0, at: Date.now() };
    } catch {
        readyCache = { ready: false, at: Date.now() };
    }
    return readyCache.ready;
}

export async function setIssueSeverity(db: Db, issueId: number, severity: IssueSeverity): Promise<boolean> {
    try {
        if (!(await severityColumnReady(db))) return false;
        await db.execute(sql`UPDATE issue_reports SET severity = ${severity}, updated_at = now() WHERE id = ${issueId}`);
        return true;
    } catch (e) {
        console.error('[issue-severity] set failed:', e instanceof Error ? e.message : e);
        return false;
    }
}

/** Issue id → severity ('normal' before the SQL). Never throws. */
export async function loadSeverities(db: Db, ids: number[]): Promise<Map<number, IssueSeverity>> {
    const out = new Map<number, IssueSeverity>();
    const clean = ids.filter((id) => Number.isInteger(id));
    if (!clean.length) return out;
    try {
        if (!(await severityColumnReady(db))) return out;
        const rows = await db.execute(sql`
            SELECT id, severity FROM issue_reports WHERE id IN (${sql.join(clean.map((id) => sql`${id}`), sql`, `)})`) as Array<{ id: number; severity: string | null }>;
        for (const r of rows) out.set(Number(r.id), isIssueSeverity(r.severity) ? r.severity : 'normal');
    } catch (e) {
        console.error('[issue-severity] load failed:', e instanceof Error ? e.message : e);
    }
    return out;
}
