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
import { and, eq, ne, desc, asc, sql, or, isNull, isNotNull, inArray, notInArray } from 'drizzle-orm';
import { incidentColumnsReady, loadIncidentFields } from '../../src/utils/platform-incident';
import { getDb } from '../../db/client';
import { issueReports, issueReportMessages, users } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { stampFixedAt, loadFixLiveFields, parsePrNumber } from '../../src/utils/issue-fix-live';
import { dispatchHotfix, syncHotfix } from '../../src/utils/issue-hotfix';
import { dispatchAiFix, buildAiFixIssueText, syncAiFix, syncOpenAiFixes, CLOUD_RUNNER_ID, AI_FIX_BULK_MAX } from '../../src/utils/issue-ai-fix';
import { dispatchCloudMerge, syncCloudMerge, syncOpenCloudMerges, MERGE_BULK_MAX } from '../../src/utils/issue-cloud-merge';
import { loadSeverities, setIssueSeverity, isIssueSeverity } from '../../src/utils/issue-severity';
import { loadOrgPlanValues } from '../../src/utils/org-plan-value';
import { ISSUE_STATUS_LABEL, isIssueStatus, notifyIssueUser, maybeAdvanceToReadyToTest, isMergeClaimStale, STALE_MERGE_MINS, type IssueStatus } from '../../src/utils/issue-reports';
import { createRoadmapItemFromIssue, isRoadmapPriority, type RoadmapPriority } from '../../src/utils/feature-roadmap';
import { withLambda } from '@netlify/aws-lambda-compat';
import { issueScreenshotUrl } from '../../src/utils/issue-screenshot-link';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { ensureStagingSql, proofColumnsReady, loadProofRow, productionChecklist, approveForProduction, syncStagingProof, importProofImages } from '../../src/utils/issue-fix-proof';
import { pipelineDbUrls, sqlHash } from '../../src/utils/issue-sql';

const jwtSecret = process.env.JWT_SECRET;

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

/** The bulk hand-offs' filter that keeps suspected incidents out. Nothing to filter before the SQL exists. */
async function notSuspected(db: Parameters<typeof incidentColumnsReady>[0]) {
    return (await incidentColumnsReady(db)) ? [sql`${issueReports}.source <> 'suspected'`] : [];
}

const HANDOFF_THANKS = "Thanks for reporting this — we've passed it to the developer and a fix is now underway.";

/** The claim written before the workflow is started: the cloud now holds the issue. */
const cloudClaim = () => ({
    devHandoffStatus: 'in_progress',
    devHandoffAt: new Date(),
    devRunnerId: CLOUD_RUNNER_ID,
    devRunnerHeartbeat: new Date(),
    devResult: 'Starting the AI fix workflow on GitHub…',
    status: 'fix_in_progress',
    updatedAt: new Date(),
});

/** Start .github/workflows/ai-fix.yml for one claimed issue. Returns an error for the admin, or null. */
async function dispatchForIssue(db: ReturnType<typeof getDb>, issue: typeof issueReports.$inferSelect, headers: Record<string, string | undefined>, note?: string): Promise<string | null> {
    const thread = await db
        .select({ authorType: issueReportMessages.authorType, body: issueReportMessages.body, createdAt: issueReportMessages.createdAt })
        .from(issueReportMessages)
        .where(eq(issueReportMessages.issueId, issue.id))
        .orderBy(asc(issueReportMessages.createdAt))
        .limit(50);
    // A signed two-hour link to the screenshot on THIS deployment (its DB holds the issue), so the
    // AI fixer can look at what the reporter saw. Null (no secret/origin) → it is told it isn't there.
    const screenshotUrl = issue.imageMime ? issueScreenshotUrl(resolveBaseUrl(headers), issue.id) : null;
    const issueText = buildAiFixIssueText({
        id: issue.id, description: issue.description, sourceLocation: issue.sourceLocation,
        sourceUrl: issue.sourceUrl, hasImage: !!issue.imageMime, screenshotSent: !!screenshotUrl, note,
    }, thread);
    return dispatchAiFix({ issueId: issue.id, issueText, screenshotUrl });
}

/** The workflow didn't start: release the claim and put the visible status back. */
async function releaseCloudClaim(db: ReturnType<typeof getDb>, id: number, prevStatus: string, err: string, restore: Partial<typeof issueReports.$inferInsert> = {}) {
    await db.update(issueReports).set({
        devHandoffStatus: 'failed', devResult: err, devRunnerId: null, devRunnerHeartbeat: null,
        status: prevStatus, updatedAt: new Date(), ...restore,
    }).where(and(eq(issueReports.id, id), eq(issueReports.devHandoffStatus, 'in_progress'), eq(issueReports.devRunnerId, CLOUD_RUNNER_ID)));
}

/**
 * The bulk passes: claim up to AI_FIX_BULK_MAX eligible issues in one status (compare-and-swap, so a
 * double click claims each once), start a workflow for each, then thread + notify the ones that started.
 * Suspected incidents are never included: they only reach the AI developer by a person's hand.
 */
async function bulkHandoff(db: ReturnType<typeof getDb>, fromStatus: 'reported' | 'backlog', adminId: number, headers: Record<string, string | undefined>) {
    const eligible = and(
        eq(issueReports.status, fromStatus),
        or(isNull(issueReports.devHandoffStatus), notInArray(issueReports.devHandoffStatus, ['queued', 'in_progress'])),
        ...(await notSuspected(db)), // §6.2: a suspected issue is only ever passed on by hand
    );
    const picked = await db.select({ id: issueReports.id }).from(issueReports)
        .where(eligible).orderBy(asc(issueReports.createdAt)).limit(AI_FIX_BULK_MAX + 1);
    const ids = picked.slice(0, AI_FIX_BULK_MAX).map((p) => p.id);
    if (!ids.length) return { claimed: [] as Array<typeof issueReports.$inferSelect>, started: [] as number[], errors: [] as string[], more: false };

    const claimed = await db.update(issueReports).set(cloudClaim())
        .where(and(inArray(issueReports.id, ids), eligible)).returning();
    const started: number[] = [];
    const errors: string[] = [];
    for (const issue of claimed) {
        const err = await dispatchForIssue(db, issue, headers);
        if (err) { errors.push(err); await releaseCloudClaim(db, issue.id, fromStatus, err); }
        else started.push(issue.id);
    }
    const ok = claimed.filter((c) => started.includes(c.id));
    if (ok.length) {
        await db.insert(issueReportMessages).values(ok.map((u) => ({
            issueId: u.id, authorType: 'admin', authorId: adminId, body: HANDOFF_THANKS, status: 'fix_in_progress',
        })));
        await Promise.allSettled(ok.map((u) =>
            notifyIssueUser(db, { userId: u.userId, issueId: u.id, status: 'fix_in_progress', headers })
                .catch((e) => console.error('[admin-issue-reports] bulk handoff notify failed:', e?.message || e)),
        ));
    }
    return { claimed, started, errors, more: picked.length > AI_FIX_BULK_MAX };
}

const bulkReply = (r: Awaited<ReturnType<typeof bulkHandoff>>) => {
    if (!r.claimed.length) return json(200, { ok: true, queued: 0 });
    if (!r.started.length) return json(502, { error: r.errors[0] || 'The AI fix workflow could not be started.' });
    return json(200, {
        ok: true, queued: r.started.length, ids: r.started, failed: r.errors.length,
        ...(r.errors.length ? { error: r.errors[0] } : {}),
        ...(r.more ? { more: true, note: `Started ${r.started.length}. Press again for the next ${AI_FIX_BULK_MAX}.` } : {}),
    });
};

async function requireAdmin(event: any): Promise<{ id: number; role: string } | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!hasPermission(row?.role, 'view_issue_reports')) return null;
    return { id: userId, role: row.role };
}

export default withLambda(async (event) => {
    const admin = await requireAdmin(event);
    if (!admin) return json(403, { error: 'Access denied. Admin role required.' });

    const db = getDb();
    const qs = event.queryStringParameters || {};
    const id = qs.id ? Number(qs.id) : null;
    const action = qs.action || '';

    // ── POST ?action=handoff: start the AI fix for this issue ─────────────────────
    // Claims the issue for the cloud (compare-and-swap, so a double click starts one run), starts
    // .github/workflows/ai-fix.yml (src/utils/issue-ai-fix.ts), moves the visible status to
    // "Fix In Progress" and notifies the reporter. syncAiFix follows the run and the PR. By hand,
    // so a suspected incident may be passed on here.
    if (event.httpMethod === 'POST' && action === 'handoff' && id) {
        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        // Only a run the cloud holds blocks a new pass. A 'queued' or laptop-held 'in_progress' row
        // left over from the retired laptop runner can be passed on again (the claim below swaps it).
        if (issue.devHandoffStatus === 'in_progress' && issue.devRunnerId === CLOUD_RUNNER_ID) {
            return json(409, { error: 'This issue has already been passed to a developer.' });
        }

        const claimed = await db.update(issueReports).set(cloudClaim()).where(and(
            eq(issueReports.id, id),
            issue.devHandoffStatus == null ? isNull(issueReports.devHandoffStatus) : eq(issueReports.devHandoffStatus, issue.devHandoffStatus),
        )).returning({ id: issueReports.id });
        if (!claimed.length) return json(409, { error: 'Someone else just passed this on — refresh the issue.' });

        const err = await dispatchForIssue(db, issue, event.headers);
        if (err) {
            await releaseCloudClaim(db, id, issue.status, err);
            return json(502, { error: err });
        }

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: admin.id,
            body: HANDOFF_THANKS,
            status: 'fix_in_progress',
        });

        await notifyIssueUser(db, { userId: issue.userId, issueId: id, status: 'fix_in_progress', headers: event.headers })
            .catch((e) => console.error('[admin-issue-reports] handoff notify failed:', e?.message || e));

        return json(200, { ok: true, devHandoffStatus: 'in_progress' });
    }

    // ── POST ?action=handoff-all: start the AI fix for Reported issues in bulk ───
    // Up to AI_FIX_BULK_MAX per click, never a suspected incident.
    if (event.httpMethod === 'POST' && action === 'handoff-all') {
        return bulkReply(await bulkHandoff(db, 'reported', admin.id, event.headers));
    }

    // ── POST ?action=handoff-backlog-all: the same for the Backlog tab ───────────
    if (event.httpMethod === 'POST' && action === 'handoff-backlog-all') {
        return bulkReply(await bulkHandoff(db, 'backlog', admin.id, event.headers));
    }

    // ── POST ?action=backlog-all: move every Reported issue to the Backlog at once ─
    // Bulk alternative to ?action=handoff-all for issues that aren't ready to hand
    // to the AI developer yet. Posts a thread message on each and notifies reporters.
    if (event.httpMethod === 'POST' && action === 'backlog-all') {
        const updated = await db.update(issueReports).set({
            status: 'backlog',
            updatedAt: new Date(),
        }).where(eq(issueReports.status, 'reported')).returning({ id: issueReports.id, userId: issueReports.userId });

        if (updated.length === 0) return json(200, { ok: true, moved: 0 });

        await db.insert(issueReportMessages).values(updated.map((u) => ({
            issueId: u.id,
            authorType: 'admin',
            authorId: admin.id,
            body: `We've updated this to "${ISSUE_STATUS_LABEL.backlog}".`,
            status: 'backlog' as IssueStatus,
        })));

        await Promise.allSettled(updated.map((u) =>
            notifyIssueUser(db, { userId: u.userId, issueId: u.id, status: 'backlog', headers: event.headers })
                .catch((e) => console.error('[admin-issue-reports] backlog-all notify failed:', e?.message || e)),
        ));

        return json(200, { ok: true, moved: updated.length, ids: updated.map((u) => u.id) });
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
        // Counts as "SQL on staging" for the production checklist only if it is the fix's own SQL.
        if (exec.ok && await proofColumnsReady(db)) {
            await db.execute(sql`
                UPDATE issue_reports SET dev_staging_sql_status = 'applied', dev_staging_sql_result = ${exec.outcome},
                       dev_staging_sql_hash = ${sqlHash(sqlText)}, dev_staging_sql_ran_at = now(),
                       dev_sql_hash = ${sqlHash(sqlText)}
                 WHERE id = ${id}`);
        }

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: admin.id,
            body: exec.ok
                ? `🗄️ The database update for this fix ran successfully on staging.\n\n${exec.outcome}`
                : `🗄️ The database update for this fix didn't go through on staging, so we've left things as they are for now.\n\n${exec.outcome}`,
            status: null,
        });

        // Applying the SQL is only one of the two gates — the issue advances to
        // "Fixed & Ready to Test" only once it's also merged to staging.
        const advanced = exec.ok ? await maybeAdvanceToReadyToTest(db, id, event.headers) : false;

        return json(200, { ok: exec.ok, outcome: exec.outcome, status: advanced ? 'fixed_ready_to_test' : issue.status });
    }

    // ── POST ?action=approve-production: the owner's final approval ─────────────────
    // Super-admin only. Re-checks the "Ready for production?" checklist server side, runs the SQL that
    // passed on staging (same hash) on the prod DB, then starts the one-fix hotfix with auto-merge
    // (src/utils/issue-fix-proof.ts approveForProduction). Body { confirm: true } after a warning.
    if (event.httpMethod === 'POST' && action === 'approve-production' && id) {
        if (!hasPermission(admin.role, 'run_migration_sql') || !hasPermission(admin.role, 'deploy_code')) {
            return json(403, { error: 'Approving for production requires super-admin privilege.' });
        }
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch { /* optional */ }
        const r = await approveForProduction(db, id, admin.id, {
            confirmWarnings: body?.confirm === true,
            dispatch: (o) => dispatchHotfix(o),
        });
        if (!r.ok) return json(r.status || 400, { error: r.error, ...(r.needsConfirm ? { needsConfirm: true } : {}) });
        return json(200, { ok: true, message: r.message });
    }

    // ── POST ?action=request-merge: merge the fix PR to staging ───────────────────
    // Super-admin only. Starts .github/workflows/merge-to-staging.yml (src/utils/issue-cloud-merge.ts);
    // syncCloudMerge records the merge and advances the issue, as the laptop runner's report used to.
    if (event.httpMethod === 'POST' && action === 'request-merge' && id) {
        if (!hasPermission(admin.role, 'deploy_code')) {
            return json(403, { error: 'Merging to staging requires the deploy_code privilege.' });
        }
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch { /* body is optional here */ }
        const force = body?.force === true;

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        if (!issue.devPrUrl) return json(400, { error: 'This issue has no pull request to merge.' });
        // Before db/z-issue-fix-proof.sql: the old gate (Run SQL by hand first). After it, ensureStagingSql
        // below runs additive SQL on the staging DB itself, just before the merge starts.
        const proofReady = await proofColumnsReady(db);
        if (!proofReady && issue.devSqlStatus === 'pending') {
            return json(400, { error: 'Run the database migration for this fix before merging to staging.' });
        }
        if (issue.devMergeStatus === 'merged') {
            return json(409, { error: 'This pull request has already been merged.' });
        }
        // A 'merging' claim blocks a re-request, UNLESS nothing has confirmed it for
        // STALE_MERGE_MINS: then a super-admin can force a restart, instead of the issue being
        // 409'd forever. `canForce` tells the UI to offer that retry. A 'queued' merge left over
        // from the retired laptop runner is simply started here (the claim below swaps it).
        const stuck = issue.devMergeStatus === 'merging';
        if (stuck && !force) {
            return isMergeClaimStale(issue.devRunnerHeartbeat)
                ? json(409, { error: `The merge looks stuck — nothing has confirmed it for over ${STALE_MERGE_MINS} minutes. Force a restart to start it again.`, canForce: true })
                : json(409, { error: 'A merge is already in progress for this issue.', canForce: false });
        }

        const prNum = parsePrNumber(issue.devPrUrl);
        if (!prNum) return json(400, { error: 'This issue\'s pull request is not in this repository, so it cannot be merged from here.' });

        // The fix's SQL goes on the STAGING DB before its code merges (docs/fix-pipeline-proof-plan.md).
        if (proofReady) {
            const sqlWait = await ensureStagingSql(db, id);
            if (sqlWait) return json(400, { error: sqlWait });
        }

        // Claim first (compare-and-swap on the status we just read), so a double click or a stale
        // force starts one merge, and a result landing meanwhile isn't overwritten. The heartbeat is
        // the start time syncCloudMerge reads (src/utils/issue-cloud-merge.ts).
        const claimed = await db.update(issueReports).set({
            devMergeStatus: 'merging',
            devMergeResult: 'Starting the merge workflow on GitHub…',
            devRunnerId: CLOUD_RUNNER_ID,
            devRunnerHeartbeat: new Date(),
            updatedAt: new Date(),
        }).where(and(
            eq(issueReports.id, id),
            issue.devMergeStatus ? eq(issueReports.devMergeStatus, issue.devMergeStatus) : isNull(issueReports.devMergeStatus),
        )).returning({ id: issueReports.id });
        if (claimed.length === 0) {
            return json(409, { error: 'This merge changed state while you were looking at it — reload the ticket and try again.' });
        }

        const err = await dispatchCloudMerge({ issueId: id, pr: prNum });
        if (err) {
            await db.update(issueReports).set({
                devMergeStatus: stuck ? 'failed' : (issue.devMergeStatus || 'ready'), devMergeResult: err,
                devRunnerId: null, devRunnerHeartbeat: null, updatedAt: new Date(),
            }).where(and(eq(issueReports.id, id), eq(issueReports.devMergeStatus, 'merging'), eq(issueReports.devRunnerId, CLOUD_RUNNER_ID)));
            return json(502, { error: err });
        }

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: admin.id,
            body: stuck
                ? '🔁 Merge restarted — the previous attempt appeared stuck, so it was reset and started again in GitHub Actions.'
                : "🔀 We're merging this fix into staging — it should be there shortly.",
            status: null,
        });

        return json(200, { ok: true, devMergeStatus: 'merging', forced: stuck });
    }

    // ── POST ?action=request-prod-promote: open a hotfix PR for THIS fix only ─────
    // Super-admin only. Replaces "Push to prod", which promoted ALL of staging to main through the
    // laptop runner. Starts .github/workflows/hotfix-pr.yml, which copies just this fix PR's merge
    // commit onto a branch from main and opens a PR into main; a person merges it on GitHub.
    // src/utils/issue-hotfix.ts follows the PR; the live check tells the reporter once prod has it.
    // The action name is kept so older admin tabs still reach the new behaviour.
    if (event.httpMethod === 'POST' && action === 'request-prod-promote' && id) {
        if (!hasPermission(admin.role, 'deploy_code')) {
            return json(403, { error: 'Opening a hotfix PR requires the deploy_code privilege.' });
        }
        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        if (issue.devMergeStatus !== 'merged') {
            return json(400, { error: 'Merge this fix to staging before opening a hotfix PR.' });
        }
        const fixPr = parsePrNumber(issue.devPrUrl);
        if (!fixPr) return json(400, { error: 'This issue has no fix PR in this repository to copy.' });
        // A 'queued' / 'promoting' promotion left over from the retired laptop runner doesn't block.
        if (issue.devProdStatus && ['hotfix_requested', 'hotfix_open'].includes(issue.devProdStatus)) {
            return json(409, { error: 'A hotfix for this issue is already in progress — see the card for its PR.' });
        }
        if (issue.devProdStatus === 'promoted') {
            return json(409, { error: 'This fix has already been merged into main.' });
        }

        // Claim first (compare-and-swap), so a double click starts one workflow, not two.
        let claimed: Array<{ id: number }>;
        try {
            claimed = await db.update(issueReports).set({
            devProdStatus: 'hotfix_requested',
            devProdAt: new Date(),
            devProdResult: 'Starting the hotfix workflow on GitHub…',
            updatedAt: new Date(),
            }).where(and(eq(issueReports.id, id), issue.devProdStatus == null ? isNull(issueReports.devProdStatus) : eq(issueReports.devProdStatus, issue.devProdStatus)))
              .returning({ id: issueReports.id });
        } catch (e) {
            // Before db/z-issue-hotfix-pr.sql the status CHECK refuses 'hotfix_requested'.
            console.error('[admin-issue-reports] hotfix claim failed:', e instanceof Error ? e.message : e);
            return json(503, { error: 'Hotfix PRs need db/z-issue-hotfix-pr.sql applied to this database first.' });
        }
        if (!claimed.length) return json(409, { error: 'Someone else just started this — refresh the issue.' });

        const err = await dispatchHotfix({ issueId: id, fixPr });
        if (err) {
            await db.update(issueReports).set({ devProdStatus: 'failed', devProdResult: err, updatedAt: new Date() })
                .where(eq(issueReports.id, id));
            return json(502, { error: err });
        }
        return json(200, { ok: true, devProdStatus: 'hotfix_requested' });
    }

    // ── POST ?action=redo-fix: write the fix again on the latest staging ──────────
    // Super-admin only, after a failed merge. Replaces "Investigate & fix conflicts", which the
    // laptop runner did by merging staging into the fix branch and having Claude resolve markers.
    // Instead this starts the AI fix workflow again (src/utils/issue-ai-fix.ts): it checks out
    // current staging, rewrites the fix, force-pushes ai-fix/issue-<id> and updates its open PR, so
    // the new PR has no conflict. The fix is rewritten, so the PR needs reviewing again.
    // 'request-conflict-fix' is kept as an alias so older admin tabs reach the new behaviour.
    if (event.httpMethod === 'POST' && (action === 'redo-fix' || action === 'request-conflict-fix') && id) {
        if (!hasPermission(admin.role, 'deploy_code')) {
            return json(403, { error: 'Redoing a fix requires the deploy_code privilege.' });
        }
        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        // 'conflict_queued' / 'conflict_resolving': a conflict fix the retired laptop runner never finished.
        if (!issue.devMergeStatus || !['failed', 'conflict_queued', 'conflict_resolving'].includes(issue.devMergeStatus)) {
            return json(409, { error: 'Only a fix whose merge failed can be redone from here.' });
        }
        if (issue.devHandoffStatus === 'in_progress' && issue.devRunnerId === CLOUD_RUNNER_ID) {
            return json(409, { error: 'The AI developer is already working on this issue.' });
        }

        // Claim first (compare-and-swap on the merge state we just read). Clearing dev_merge_status
        // moves the card back to "fixing"; syncAiFix sets it to 'ready' when the new PR is there.
        const claimed = await db.update(issueReports).set({ ...cloudClaim(), devMergeStatus: null, devMergeResult: null })
            .where(and(eq(issueReports.id, id), eq(issueReports.devMergeStatus, issue.devMergeStatus)))
            .returning({ id: issueReports.id });
        if (!claimed.length) return json(409, { error: 'This issue changed while you were looking at it — reload it and try again.' });

        const note = `The previous fix (${issue.devPrUrl || 'its pull request'}) could not be merged into staging, most likely because staging changed underneath it. Write the fix again against the current code. The thread below includes the previous attempt and why its merge failed.`;
        const err = await dispatchForIssue(db, issue, event.headers, note);
        if (err) {
            await releaseCloudClaim(db, id, issue.status, err, { devMergeStatus: 'failed', devMergeResult: issue.devMergeResult, devHandoffStatus: issue.devHandoffStatus });
            return json(502, { error: err });
        }

        const oldFixBranch = issue.devBranch && !issue.devBranch.startsWith('ai-fix/');
        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: admin.id,
            body: `🔁 The merge failed, so the AI developer is writing the fix again on the latest staging. The new version needs reviewing before it is merged.${oldFixBranch ? `\n\nThe old pull request (${issue.devPrUrl}) is left open; close it once the new one is ready.` : ''}`,
            status: null,
        });
        // An engineering step: the reporter hears once the fix is live, not now.
        return json(200, { ok: true, devHandoffStatus: 'in_progress' });
    }

    // ── POST ?action=request-merge-all: merge every ready fix PR at once ──────────
    // Bulk version of ?action=request-merge, for the "Fix In Progress" tab. Claims up to
    // MERGE_BULK_MAX issues whose fix PR is ready (or whose last merge failed), skipping any fix
    // still gated on a pending DB migration, then starts the merge workflow for each.
    if (event.httpMethod === 'POST' && action === 'request-merge-all') {
        if (!hasPermission(admin.role, 'deploy_code')) {
            return json(403, { error: 'Merging to staging requires the deploy_code privilege.' });
        }
        const eligible = and(
            isNotNull(issueReports.devPrUrl),
            inArray(issueReports.devMergeStatus, ['ready', 'failed']),
            or(isNull(issueReports.devSqlStatus), ne(issueReports.devSqlStatus, 'pending')),
        );
        // After db/z-issue-fix-proof.sql, fixes waiting on SQL are picked too: ensureStagingSql runs their
        // additive SQL on staging first (it sets dev_sql_status 'applied', so `eligible` then holds).
        const proofReady = await proofColumnsReady(db);
        const candidates = proofReady
            ? and(isNotNull(issueReports.devPrUrl), inArray(issueReports.devMergeStatus, ['ready', 'failed']))
            : eligible;
        const picked = await db.select({ id: issueReports.id }).from(issueReports)
            .where(candidates).orderBy(asc(issueReports.devHandoffAt)).limit(MERGE_BULK_MAX + 1);
        const ids: number[] = [];
        const sqlErrors: string[] = [];
        for (const p of picked.slice(0, MERGE_BULK_MAX)) {
            const wait = proofReady ? await ensureStagingSql(db, p.id) : null;
            if (wait) sqlErrors.push(`#${p.id}: ${wait.split('\n')[0]}`);
            else ids.push(p.id);
        }
        if (ids.length === 0) return json(200, { ok: true, queued: 0, ...(sqlErrors.length ? { failed: sqlErrors.length, error: sqlErrors.join('\n') } : {}) });

        const claimed = await db.update(issueReports).set({
            devMergeStatus: 'merging',
            devMergeResult: 'Starting the merge workflow on GitHub…',
            devRunnerId: CLOUD_RUNNER_ID,
            devRunnerHeartbeat: new Date(),
            updatedAt: new Date(),
        }).where(and(inArray(issueReports.id, ids), eligible))
          .returning({ id: issueReports.id, devPrUrl: issueReports.devPrUrl });

        const started: number[] = [];
        const errors: string[] = [...sqlErrors];
        for (const c of claimed) {
            const prNum = parsePrNumber(c.devPrUrl);
            const err = prNum ? await dispatchCloudMerge({ issueId: c.id, pr: prNum }) : 'The pull request is not in this repository.';
            if (err) {
                errors.push(err);
                await db.update(issueReports).set({ devMergeStatus: 'failed', devMergeResult: err, devRunnerId: null, devRunnerHeartbeat: null, updatedAt: new Date() })
                    .where(and(eq(issueReports.id, c.id), eq(issueReports.devMergeStatus, 'merging'), eq(issueReports.devRunnerId, CLOUD_RUNNER_ID)));
            } else started.push(c.id);
        }
        if (claimed.length && !started.length) return json(502, { error: errors[0] || 'The merge workflow could not be started.' });

        if (started.length) {
            await db.insert(issueReportMessages).values(started.map((sid) => ({
                issueId: sid,
                authorType: 'admin',
                authorId: admin.id,
                body: "🔀 We're merging this fix into staging — it should be there shortly.",
                status: null,
            })));
        }

        return json(200, {
            ok: true, queued: started.length, ids: started, failed: errors.length,
            ...(errors.length ? { error: errors[0] } : {}),
            ...(picked.length > MERGE_BULK_MAX ? { more: true, note: `Started ${started.length}. Press again for the next ${MERGE_BULK_MAX}.` } : {}),
        });
    }

    // Staging is rebuilt automatically once no merge is left in flight — see
    // triggerStagingDeployIfDrained(), called when syncCloudMerge records a merge outcome.

    // ── GET ?action=version: has anything changed? (the board's auto-refresh polls this) ──
    if (event.httpMethod === 'GET' && action === 'version') {
        const [v] = await db.execute(sql`
            SELECT coalesce(max(updated_at)::text, '') || '|' || count(*)::text || '|' ||
                   (SELECT coalesce(max(id), 0)::text FROM issue_report_messages) AS version
              FROM issue_reports`) as Array<{ version: string }>;
        return json(200, { version: v?.version || '' });
    }

    // ── GET single issue (with thread + screenshot) ──────────────────────────────
    if (event.httpMethod === 'GET' && id) {
        let [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        // A hotfix in flight: follow it on GitHub now, so the card is current when the admin looks.
        if (await syncHotfix(db, issue)) {
            [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        }
        // An AI fix running in GitHub Actions: pick up its PR, failure or progress now.
        if (await syncAiFix(db, issue)) {
            [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        }
        // A merge to staging running in GitHub Actions: record it (and move the issue on) now.
        if (await syncCloudMerge(db, issue, { headers: event.headers })) {
            [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        }
        // No reporter on an automatic incident (source 'system' | 'suspected').
        const [reporter] = issue.userId == null ? [] : await db
            .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
            .from(users).where(eq(users.id, issue.userId)).limit(1);
        // Proof before production: follow staging CI / deploy and pull in the repro screenshots now.
        let proof: ReturnType<typeof productionChecklist> & { row: Awaited<ReturnType<typeof loadProofRow>>; onProdSite: boolean } | null = null;
        let proofRow = await loadProofRow(db, id);
        if (proofRow) {
            let again = false;
            if (proofRow.devMergeStatus === 'merged' && !proofRow.devProdApprovedAt && (proofRow.devStagingCiStatus !== 'passed' || !proofRow.devStagingLiveAt)) {
                again = await syncStagingProof(db, proofRow) || again;
            }
            if (proofRow.devProofRunId && !proofRow.devProofImagesAt) {
                again = await importProofImages(db, id, proofRow.devProofRunId) || again;
            }
            if (again) proofRow = await loadProofRow(db, id);
            if (proofRow) proof = { ...productionChecklist(proofRow), row: proofRow, onProdSite: pipelineDbUrls().onProdSite };
        }
        const messages = proofRow
            ? (await db.execute(sql`
                SELECT id, issue_id AS "issueId", author_type AS "authorType", author_id AS "authorId", body, status,
                       created_at AS "createdAt",
                       CASE WHEN image_data IS NOT NULL THEN 'data:' || image_mime || ';base64,' || image_data END AS "imageUrl"
                  FROM issue_report_messages WHERE issue_id = ${id} ORDER BY created_at ASC`) as unknown[])
            : await db.select().from(issueReportMessages)
                .where(eq(issueReportMessages.issueId, id))
                .orderBy(asc(issueReportMessages.createdAt));
        return json(200, {
            proof,
            issue: {
                ...issue,
                statusLabel: ISSUE_STATUS_LABEL[issue.status as IssueStatus] || issue.status,
                reporterName: issue.userId == null ? 'Automatic (Be More Swan)' : [reporter?.firstName, reporter?.lastName].filter(Boolean).join(' ') || reporter?.email || `User #${issue.userId}`,
                reporterEmail: reporter?.email || null,
                ...((await loadIncidentFields(db, [issue.id])).get(issue.id) ?? { source: 'user', occurrences: 1, lastSeenAt: null, incident: null }),
                severity: (await loadSeverities(db, [issue.id])).get(issue.id) ?? 'normal',
            },
            messages,
        });
    }

    // ── GET list ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        // Cloud AI fixes in flight: record finished ones so the list and board are current (capped).
        await syncOpenAiFixes(db, { limit: 5 });
        await syncOpenCloudMerges(db, { limit: 5 });

        const status = qs.status && isIssueStatus(qs.status) ? qs.status : null;
        const where = status ? eq(issueReports.status, status) : undefined;
        const rows = await db
            .select({
                id: issueReports.id,
                userId: issueReports.userId,
                organisationId: issueReports.organisationId,
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
                devProdStatus: issueReports.devProdStatus,
                devProdAt: issueReports.devProdAt,
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

        // Automatic incidents (§6.2): their columns are read raw, so this works before the SQL is applied.
        const incidents = await loadIncidentFields(db, rows.map((r) => r.id));
        // Live check fields (issue-fix-live.ts) for the board's "Waiting to go live" / "closes in N days".
        const fixLive = await loadFixLiveFields(db, rows.map((r) => r.id));
        // Severity (issue-severity.ts) and what the reporter's workspace pays (org-plan-value.ts).
        const severities = await loadSeverities(db, rows.map((r) => r.id));
        const planValues = await loadOrgPlanValues(db, rows.map((r) => r.organisationId));

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
                devProdStatus: r.devProdStatus,
                devProdAt: r.devProdAt,
                devRunnerId: r.devRunnerId,
                devRunnerHeartbeat: r.devRunnerHeartbeat,
                reporterName: r.userId == null ? 'Automatic (Be More Swan)' : [r.reporterFirst, r.reporterLast].filter(Boolean).join(' ') || r.reporterEmail || `User #${r.userId}`,
                reporterEmail: r.reporterEmail,
                source: incidents.get(r.id)?.source ?? 'user',
                occurrences: incidents.get(r.id)?.occurrences ?? 1,
                lastSeenAt: incidents.get(r.id)?.lastSeenAt ?? null,
                fixedAt: fixLive.get(r.id)?.fixedAt ?? null,
                liveAt: fixLive.get(r.id)?.liveAt ?? null,
                awaitingLive: !!r.devPrUrl && r.devMergeStatus === 'merged' && fixLive.get(r.id)?.livePrUrl !== r.devPrUrl,
                severity: severities.get(r.id) ?? 'normal',
                planName: r.organisationId != null ? (planValues.get(r.organisationId)?.planName ?? 'No plan') : null,
                planMonthlyGbp: r.organisationId != null ? (planValues.get(r.organisationId)?.monthlyGbp ?? 0) : 0,
                paying: r.organisationId != null ? !!planValues.get(r.organisationId)?.paying : false,
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

        // Severity is its own edit too (issue-severity.ts): no status change, no reporter notification.
        if (body.severity !== undefined) {
            if (!isIssueSeverity(body.severity)) return json(400, { error: 'Severity must be critical, high, normal or low.' });
            if (!(await setIssueSeverity(db, id, body.severity))) return json(503, { error: 'Severity needs db/z-issue-severity.sql applied first.' });
            if (body.status === undefined && body.message === undefined && description === null) return json(200, { ok: true, severity: body.severity });
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
            // Set by hand: start the 7-day auto-close clock (issue-fix-live.ts).
            if (newStatus === 'fixed_ready_to_test') await stampFixedAt(db, id);
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
                submittedBy: issue.userId,
            }).catch((e) => console.error('[admin-issue-reports] roadmap promote failed:', e?.message || e));
        }

        // Record the supporting message / status change in the thread.
        if (message || newStatus) {
            const autoBody = `We've updated this to "${ISSUE_STATUS_LABEL[finalStatus]}".`;
            await db.insert(issueReportMessages).values({
                issueId: id,
                authorType: 'admin',
                authorId: admin.id,
                body: message || autoBody,
                status: newStatus,
            });
        }

        // Notify the reporting user so they can act (re-test or supply more info).
        await notifyIssueUser(db, { userId: issue.userId, issueId: id, status: finalStatus, adminMessage: message, headers: event.headers })
            .catch((e) => console.error('[admin-issue-reports] user notify failed:', e?.message || e));

        return json(200, { ok: true, status: finalStatus });
    }

    return json(405, { error: 'Method Not Allowed.' });
});

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
    // The STAGING DB, wherever this is clicked: on the prod site that is STAGING_DATABASE_URL. It used to
    // fall back to the site's own DB, so on bemoreswan.com it ran on PROD while saying "staging".
    const url = pipelineDbUrls().staging;
    if (!url) return { ok: false, outcome: 'No staging database is configured here (set STAGING_DATABASE_URL in Netlify, production context).' };

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
