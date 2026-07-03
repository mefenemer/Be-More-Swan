// netlify/functions/admin-issue-reports.ts
// Testing-phase "Report an Issue" — Admin Portal API (Testing section).
//
// GET   /admin-issue-reports                     → all issues (newest first), optional ?status=
// GET   /admin-issue-reports?id=N                → single issue + full message thread + screenshot
// PATCH /admin-issue-reports?id=N { status?, message? }
//                                                → update status and/or post a supporting message,
//                                                  then notify the reporting user (in-app + email).
//
// Admin-only (users.role IN admin roles). On every status change the user is notified so they
// can re-test the fix or supply more information.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import postgres from 'postgres';
import { and, eq, desc, asc, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { issueReports, issueReportMessages, users, devRunnerStatus } from '../../db/schema';
import { isAdminRole, hasPermission } from '../../src/utils/rbac';
import { ISSUE_STATUS_LABEL, isIssueStatus, notifyIssueUser, maybeAdvanceToReadyToTest, type IssueStatus } from '../../src/utils/issue-reports';
import { createRoadmapItemFromIssue, isRoadmapPriority, type RoadmapPriority } from '../../src/utils/feature-roadmap';

const jwtSecret = process.env.JWT_SECRET;

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<{ id: number; role: string } | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !isAdminRole(row.role)) return null;
    return { id: userId, role: row.role };
}

export const handler: Handler = async (event) => {
    const admin = await requireAdmin(event);
    if (!admin) return json(403, { error: 'Access denied. Admin role required.' });

    const db = getDb();
    const qs = event.queryStringParameters || {};
    const id = qs.id ? Number(qs.id) : null;
    const action = qs.action || '';

    // ── POST ?action=handoff: queue the issue for AI auto-fix ────────────────────
    // Flags the issue for a local Claude Code runner (see scripts/dev-issue-fixer.mjs),
    // moves the user-visible status to "Fix In Progress", and notifies the reporter.
    if (event.httpMethod === 'POST' && action === 'handoff' && id) {
        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        if (issue.devHandoffStatus === 'queued' || issue.devHandoffStatus === 'in_progress') {
            return json(409, { error: 'This issue has already been passed to a developer.' });
        }

        await db.update(issueReports).set({
            devHandoffStatus: 'queued',
            devHandoffAt: new Date(),
            devResult: null,
            status: 'fix_in_progress',
            updatedAt: new Date(),
        }).where(eq(issueReports.id, id));

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: admin.id,
            body: '🤖 Passed to the developer for AI auto-fix. A fix is now in progress.',
            status: 'fix_in_progress',
        });

        await notifyIssueUser(db, { userId: issue.userId, issueId: id, status: 'fix_in_progress', headers: event.headers })
            .catch((e) => console.error('[admin-issue-reports] handoff notify failed:', e?.message || e));

        return json(200, { ok: true, devHandoffStatus: 'queued' });
    }

    // ── POST ?action=run-sql: run the AI-proposed migration against staging Neon ──
    // Super-admin only. Executes the SQL on the deployment's owner DB connection and
    // returns the database's outcome. Only a SUCCESSFUL run advances the issue to
    // "Fixed & Ready to Test"; a failure leaves the issue untouched for another attempt.
    if (event.httpMethod === 'POST' && action === 'run-sql' && id) {
        if (!hasPermission(admin.role, 'run_migration_sql')) {
            return json(403, { error: 'Running migration SQL requires super-admin privilege.' });
        }
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });

        // Admin may have edited the AI's SQL in the textarea; fall back to the stored SQL.
        const sqlText = (typeof body.sql === 'string' && body.sql.trim() ? body.sql : issue.devSql || '').trim();
        if (!sqlText) return json(400, { error: 'No SQL to run for this issue.' });

        const exec = await runMigrationSql(sqlText);

        await db.update(issueReports).set({
            devSql: sqlText,
            devSqlStatus: exec.ok ? 'applied' : 'failed',
            devSqlResult: exec.outcome,
            devSqlRanAt: new Date(),
            updatedAt: new Date(),
        }).where(eq(issueReports.id, id));

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: admin.id,
            body: exec.ok
                ? `🗄️ Migration SQL ran successfully against staging.\n\n${exec.outcome}`
                : `🗄️ Migration SQL FAILED on staging — issue left as-is.\n\n${exec.outcome}`,
            status: null,
        });

        // Applying the SQL is only one of the two gates — the issue advances to
        // "Fixed & Ready to Test" only once it's also merged to staging.
        const advanced = exec.ok ? await maybeAdvanceToReadyToTest(db, id, event.headers) : false;

        return json(200, { ok: exec.ok, outcome: exec.outcome, status: advanced ? 'fixed_ready_to_test' : issue.status });
    }

    // ── POST ?action=request-merge: queue a merge of the fix PR to staging ────────
    // Super-admin only. The local watcher claims the queued merge and runs `gh pr merge`;
    // a successful merge (plus any applied migration) is what advances the issue.
    if (event.httpMethod === 'POST' && action === 'request-merge' && id) {
        if (admin.role !== 'super_admin') {
            return json(403, { error: 'Merging to staging requires super-admin privilege.' });
        }
        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        if (!issue.devPrUrl) return json(400, { error: 'This issue has no pull request to merge.' });
        if (issue.devSqlStatus === 'pending') {
            return json(400, { error: 'Run the database migration for this fix before merging to staging.' });
        }
        if (issue.devMergeStatus === 'queued' || issue.devMergeStatus === 'merging') {
            return json(409, { error: 'A merge is already in progress for this issue.' });
        }
        if (issue.devMergeStatus === 'merged') {
            return json(409, { error: 'This pull request has already been merged.' });
        }

        await db.update(issueReports).set({
            devMergeStatus: 'queued',
            devMergeResult: null,
            updatedAt: new Date(),
        }).where(eq(issueReports.id, id));

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: admin.id,
            body: '🔀 Merge to staging requested — the developer runner will merge the pull request shortly.',
            status: null,
        });

        return json(200, { ok: true, devMergeStatus: 'queued' });
    }

    // ── GET ?action=runner-status: AI auto-fix runner health ─────────────────────
    // Powers the "runner paused — Claude session limit" prompt + Resume button. Returns every
    // runner's current state so the portal can surface a block and show how to recover it.
    if (event.httpMethod === 'GET' && action === 'runner-status') {
        const rows = await db.select().from(devRunnerStatus).orderBy(desc(devRunnerStatus.updatedAt));
        const runners = rows.map((r) => ({
            runnerId: r.runnerId,
            state: r.state,
            message: r.message,
            resetHint: r.resetHint,
            blockedIssueId: r.blockedIssueId,
            resumeRequested: r.resumeRequested,
            lastProbeResult: r.lastProbeResult,
            activeAccount: r.activeAccount,
            blockedAt: r.blockedAt,
            lastSeenAt: r.lastSeenAt,
        }));
        return json(200, { runners, blocked: runners.filter((r) => r.state === 'session_limited') });
    }

    // ── POST ?action=resume-runner: ask a paused runner to re-verify + resume ─────
    // Super-admin only. The admin logs into a funded Claude account ON THE RUNNER MACHINE, then
    // presses Resume. This only flags resume_requested — the runner (the sole thing that can
    // reach the CLI) verifies the new login with a probe and flips itself back to 'ok'. Optionally
    // scope to one runnerId; default resumes every currently-blocked runner.
    if (event.httpMethod === 'POST' && action === 'resume-runner') {
        if (admin.role !== 'super_admin') {
            return json(403, { error: 'Resuming the runner requires super-admin privilege.' });
        }
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { /* empty body is fine */ }
        const rid = typeof body.runnerId === 'string' && body.runnerId.trim() ? body.runnerId.trim() : null;

        const whereBlocked = rid
            ? and(eq(devRunnerStatus.runnerId, rid), eq(devRunnerStatus.state, 'session_limited'))
            : eq(devRunnerStatus.state, 'session_limited');

        const updated = await db.update(devRunnerStatus)
            .set({ resumeRequested: true, lastProbeResult: null, updatedAt: new Date() })
            .where(whereBlocked)
            .returning({ runnerId: devRunnerStatus.runnerId });

        if (updated.length === 0) {
            return json(200, { ok: true, resumed: 0, message: 'No paused runner to resume. Make sure the runner process is running and has reported a session limit.' });
        }
        return json(200, { ok: true, resumed: updated.length, runners: updated.map((u) => u.runnerId) });
    }

    // ── GET single issue (with thread + screenshot) ──────────────────────────────
    if (event.httpMethod === 'GET' && id) {
        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        const [reporter] = await db
            .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
            .from(users).where(eq(users.id, issue.userId)).limit(1);
        const messages = await db.select().from(issueReportMessages)
            .where(eq(issueReportMessages.issueId, id))
            .orderBy(asc(issueReportMessages.createdAt));
        return json(200, {
            issue: {
                ...issue,
                statusLabel: ISSUE_STATUS_LABEL[issue.status as IssueStatus] || issue.status,
                reporterName: [reporter?.firstName, reporter?.lastName].filter(Boolean).join(' ') || reporter?.email || `User #${issue.userId}`,
                reporterEmail: reporter?.email || null,
            },
            messages,
        });
    }

    // ── GET list ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const status = qs.status && isIssueStatus(qs.status) ? qs.status : null;
        const where = status ? eq(issueReports.status, status) : undefined;
        const rows = await db
            .select({
                id: issueReports.id,
                userId: issueReports.userId,
                description: issueReports.description,
                sourceLocation: issueReports.sourceLocation,
                status: issueReports.status,
                imageMime: issueReports.imageMime,
                createdAt: issueReports.createdAt,
                updatedAt: issueReports.updatedAt,
                devHandoffStatus: issueReports.devHandoffStatus,
                devPrUrl: issueReports.devPrUrl,
                devSqlStatus: issueReports.devSqlStatus,
                devMergeStatus: issueReports.devMergeStatus,
                devRunnerId: issueReports.devRunnerId,
                devRunnerHeartbeat: issueReports.devRunnerHeartbeat,
                reporterEmail: users.email,
                reporterFirst: users.firstName,
                reporterLast: users.lastName,
            })
            .from(issueReports)
            .leftJoin(users, eq(users.id, issueReports.userId))
            .where(where as any)
            .orderBy(desc(issueReports.createdAt))
            .limit(300);

        // Status counts for the filter chips.
        const counts = await db
            .select({ status: issueReports.status, n: sql<number>`count(*)::int` })
            .from(issueReports)
            .groupBy(issueReports.status);

        return json(200, {
            issues: rows.map((r) => ({
                id: r.id,
                description: r.description,
                sourceLocation: r.sourceLocation,
                status: r.status,
                statusLabel: ISSUE_STATUS_LABEL[r.status as IssueStatus] || r.status,
                hasImage: !!r.imageMime,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
                devHandoffStatus: r.devHandoffStatus,
                devPrUrl: r.devPrUrl,
                devSqlStatus: r.devSqlStatus,
                devMergeStatus: r.devMergeStatus,
                devRunnerId: r.devRunnerId,
                devRunnerHeartbeat: r.devRunnerHeartbeat,
                reporterName: [r.reporterFirst, r.reporterLast].filter(Boolean).join(' ') || r.reporterEmail || `User #${r.userId}`,
                reporterEmail: r.reporterEmail,
            })),
            counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        });
    }

    // ── PATCH: update status and/or post a message, then notify the user ─────────
    if (event.httpMethod === 'PATCH' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });

        // Admins can correct/clarify the reporter's description. This is an independent
        // edit — it doesn't change status, thread a message, or notify the reporter.
        const description = typeof body.description === 'string' ? body.description.trim() : null;
        if (description !== null) {
            if (!description) return json(400, { error: 'Description cannot be empty.' });
            await db.update(issueReports)
                .set({ description, updatedAt: new Date() })
                .where(eq(issueReports.id, id));
        }

        const newStatus: IssueStatus | null = isIssueStatus(body.status) ? body.status : null;
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!newStatus && !message) {
            // Description-only edit — nothing left to notify about.
            if (description !== null) return json(200, { ok: true, description });
            return json(400, { error: 'Provide a status and/or a message.' });
        }

        const finalStatus = newStatus || (issue.status as IssueStatus);

        if (newStatus) {
            // 'roadmap' is a terminal state like 'closed' from the reporter's point of view —
            // stamp resolvedAt so it leaves the open-issue triage queue.
            const isTerminal = newStatus === 'closed' || newStatus === 'roadmap';
            await db.update(issueReports)
                .set({
                    status: newStatus,
                    updatedAt: new Date(),
                    resolvedAt: isTerminal ? new Date() : issue.resolvedAt,
                })
                .where(eq(issueReports.id, id));
        }

        // Promoting to the roadmap creates (or refreshes) a Feature Roadmap item carrying the
        // chosen priority. Idempotent — re-promoting the same issue won't duplicate it.
        if (newStatus === 'roadmap') {
            const priority: RoadmapPriority | undefined = isRoadmapPriority(body.priority) ? body.priority : undefined;
            const firstLine = (issue.description || '').split('\n')[0].trim();
            await createRoadmapItemFromIssue(db, {
                issueId: id,
                title: firstLine || `Feature request from issue #${id}`,
                description: issue.description,
                priority,
                createdBy: admin.id,
            }).catch((e) => console.error('[admin-issue-reports] roadmap promote failed:', e?.message || e));
        }

        // Record the supporting message / status change in the thread.
        if (message || newStatus) {
            await db.insert(issueReportMessages).values({
                issueId: id,
                authorType: 'admin',
                authorId: admin.id,
                body: message || `Status changed to "${ISSUE_STATUS_LABEL[finalStatus]}".`,
                status: newStatus,
            });
        }

        // Notify the reporting user so they can act (re-test or supply more info).
        await notifyIssueUser(db, { userId: issue.userId, issueId: id, status: finalStatus, adminMessage: message, headers: event.headers })
            .catch((e) => console.error('[admin-issue-reports] user notify failed:', e?.message || e));

        return json(200, { ok: true, status: finalStatus });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};

/**
 * Execute admin-approved migration SQL against the deployment's owner DB connection
 * (on the staging deploy, NETLIFY_DATABASE_URL → staging Neon; set MIGRATION_DATABASE_URL
 * to use a dedicated owner/migration role instead).
 *
 * Mirrors how a human applies db/*.sql with `psql -f`: a short-lived owner connection and
 * the SIMPLE query protocol, so multiple statements and DO/$$ blocks run in one shot. No
 * implicit BEGIN/COMMIT wrapper — our migration files are idempotent and self-contained,
 * so this matches the manual apply exactly. Never throws; returns the DB's outcome as text.
 */
async function runMigrationSql(sqlText: string): Promise<{ ok: boolean; outcome: string }> {
    const url = process.env.MIGRATION_DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
    if (!url) return { ok: false, outcome: 'No database URL configured (MIGRATION_DATABASE_URL / NETLIFY_DATABASE_URL).' };

    const notices: string[] = [];
    const client = postgres(url, {
        max: 1,
        connect_timeout: 8,
        idle_timeout: 5,
        onnotice: (n: any) => { if (n?.message) notices.push(String(n.message)); },
    });
    try {
        // Cap runaway statements, then run the migration via the simple protocol.
        await client.unsafe("SET statement_timeout = '60s'").simple();
        const res: any = await client.unsafe(sqlText).simple();
        const sets = Array.isArray(res) ? res.length : 0;
        const lines = [
            '✓ Executed successfully on staging.',
            sets ? `Statements / result sets: ${sets}` : '',
            notices.length ? `Notices:\n${notices.join('\n')}` : '',
        ].filter(Boolean);
        return { ok: true, outcome: lines.join('\n') };
    } catch (e: any) {
        const parts = [
            `✗ ${e?.message || 'SQL execution failed.'}`,
            e?.code ? `Code: ${e.code}` : '',
            e?.detail ? `Detail: ${e.detail}` : '',
            e?.hint ? `Hint: ${e.hint}` : '',
            e?.where ? `Where: ${e.where}` : '',
            notices.length ? `Notices:\n${notices.join('\n')}` : '',
        ].filter(Boolean);
        return { ok: false, outcome: parts.join('\n') };
    } finally {
        await client.end({ timeout: 5 }).catch(() => {});
    }
}
