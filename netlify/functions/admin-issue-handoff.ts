// netlify/functions/admin-issue-handoff.ts
// "Pass to Developer" — machine-to-machine endpoint for the local AI auto-fix runner.
//
// The admin portal queues an issue (POST /admin-issue-reports?action=handoff, cookie-auth).
// A watcher running on a developer machine — where the repo + Claude Code live — then
// drives the actual fix and talks to THIS endpoint. Because the runner has no admin
// session, it authenticates with a shared secret (DEV_HANDOFF_TOKEN) instead of a cookie.
//
//   GET  /admin-issue-handoff?action=claim
//        → atomically claims the oldest queued issue (queued → in_progress) and returns
//          its detail. { issue: null } when the queue is empty.
//
//   POST /admin-issue-handoff?id=N   { ok, summary, branch?, prUrl? }
//        → ok:true  → records branch/PR/summary, status → 'fixed_ready_to_test',
//                     threads the result and notifies the reporter.
//          ok:false → marks the handoff 'failed' (visible status left as 'fix_in_progress')
//                     and threads the failure reason for the admin.
//
//   GET  /admin-issue-handoff?action=claim-conflict-fix
//        → atomically claims the oldest queued conflict fix (conflict_queued → conflict_resolving).
//   POST /admin-issue-handoff?id=N&action=conflict-fix-result   { ok, outcome? }
//        → ok:true  → dev_merge_status → 'merged', same advance-to-ready-to-test path as a merge.
//          ok:false → dev_merge_status → 'failed' again, for another attempt.
//
// Auth: header `x-handoff-token: <DEV_HANDOFF_TOKEN>` or `Authorization: Bearer <token>`.
// If DEV_HANDOFF_TOKEN is unset the endpoint is disabled (503) — the feature is opt-in.

import { Handler } from '@netlify/functions';
import { and, eq, asc, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { issueReports, issueReportMessages, users } from '../../db/schema';
import { ISSUE_STATUS_LABEL, maybeAdvanceToReadyToTest, triggerStagingDeployIfDrained } from '../../src/utils/issue-reports';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

// A claimed issue keeps its runner via a heartbeat POSTed every ~60s while the fix runs. If a
// runner dies mid-fix (crash, power loss, killed terminal) the issue would otherwise sit in
// 'in_progress' forever with no one working it. So when a runner asks for the next issue we
// first re-queue any 'in_progress' issue whose heartbeat is older than this window — comfortably
// more than the ~60s beat, so a runner busy on a long single fix is never reclaimed out from under
// itself. The dead runner's next report is a no-op (the issue is no longer assigned to it).
const FIX_RECLAIM_MS = Number(process.env.DEV_FIX_RECLAIM_MS) || 5 * 60_000;

// Identity the runner sends about itself (default in the script is `${hostname}:${pid}`).
// Purely informational — it's shown in the admin portal so you can tell which of several
// concurrent runners is working which issue. Bounded so a rogue value can't bloat the row.
function runnerId(event: any): string | null {
    const h = event.headers || {};
    const v = (h['x-runner-id'] || h['X-Runner-Id'] || '').toString().trim();
    return v ? v.slice(0, 120) : null;
}

function authOk(event: any): boolean {
    const expected = process.env.DEV_HANDOFF_TOKEN;
    if (!expected) return false; // disabled
    const h = event.headers || {};
    const bearer = (h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '').trim();
    const token = (h['x-handoff-token'] || h['X-Handoff-Token'] || bearer || '').trim();
    // Constant-ish comparison; tokens are short so timing leakage is negligible here.
    return token.length > 0 && token === expected;
}

export const handler: Handler = async (event) => {
    if (!process.env.DEV_HANDOFF_TOKEN) {
        return json(503, { error: 'AI auto-fix handoff is not configured (DEV_HANDOFF_TOKEN unset).' });
    }
    if (!authOk(event)) return json(401, { error: 'Invalid or missing handoff token.' });

    const db = getDb();
    const qs = event.queryStringParameters || {};
    const action = qs.action || '';
    const id = qs.id ? Number(qs.id) : null;

    // ── Claim the next queued issue ──────────────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'claim') {
        // Reclaim issues abandoned by a dead runner: an 'in_progress' row whose heartbeat has
        // gone stale is put back in the queue (identity cleared) so it can be re-claimed below.
        await db.update(issueReports)
            .set({ devHandoffStatus: 'queued', devRunnerId: null, devRunnerHeartbeat: null, updatedAt: new Date() })
            .where(and(
                eq(issueReports.devHandoffStatus, 'in_progress'),
                lt(issueReports.devRunnerHeartbeat, new Date(Date.now() - FIX_RECLAIM_MS)),
            ));

        const [next] = await db
            .select({ id: issueReports.id })
            .from(issueReports)
            .where(eq(issueReports.devHandoffStatus, 'queued'))
            .orderBy(asc(issueReports.devHandoffAt))
            .limit(1);
        if (!next) return json(200, { issue: null });

        // Compare-and-swap so two runners can't grab the same issue. The winner stamps its
        // identity + a claim timestamp so the admin portal can show who's fixing what.
        const claimed = await db.update(issueReports)
            .set({ devHandoffStatus: 'in_progress', devRunnerId: runnerId(event), devRunnerHeartbeat: new Date(), updatedAt: new Date() })
            .where(and(eq(issueReports.id, next.id), eq(issueReports.devHandoffStatus, 'queued')))
            .returning({ id: issueReports.id });
        if (claimed.length === 0) return json(200, { issue: null }); // lost the race; runner will poll again

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, next.id)).limit(1);
        const [reporter] = await db
            .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
            .from(users).where(eq(users.id, issue.userId)).limit(1);

        // The ticket thread. On a retry the reporter's "why the fix didn't work" comments
        // (and the previous attempt's summary) live here — without them the fixer would
        // regenerate the exact fix that already failed testing.
        const thread = await db
            .select({
                authorType: issueReportMessages.authorType,
                body: issueReportMessages.body,
                status: issueReportMessages.status,
                createdAt: issueReportMessages.createdAt,
            })
            .from(issueReportMessages)
            .where(eq(issueReportMessages.issueId, next.id))
            .orderBy(asc(issueReportMessages.createdAt))
            .limit(50);

        return json(200, {
            issue: {
                id: issue.id,
                description: issue.description,
                sourceLocation: issue.sourceLocation,
                sourceUrl: issue.sourceUrl,
                userAgent: issue.userAgent,
                hasImage: !!issue.imageMime,
                status: issue.status,
                createdAt: issue.createdAt,
                reporterName: [reporter?.firstName, reporter?.lastName].filter(Boolean).join(' ') || reporter?.email || `User #${issue.userId}`,
                reporterEmail: reporter?.email || null,
                thread,
            },
        });
    }

    // ── Claim the next queued MERGE ──────────────────────────────────────────────
    // A super-admin pressed "Merge to staging" (dev_merge_status='queued'); the runner
    // claims it (queued → merging), merges the PR, then POSTs ?action=merge-result.
    if (event.httpMethod === 'GET' && action === 'claim-merge') {
        const [next] = await db
            .select({ id: issueReports.id })
            .from(issueReports)
            .where(eq(issueReports.devMergeStatus, 'queued'))
            .orderBy(asc(issueReports.devHandoffAt))
            .limit(1);
        if (!next) return json(200, { issue: null });

        const claimed = await db.update(issueReports)
            .set({ devMergeStatus: 'merging', devRunnerId: runnerId(event), devRunnerHeartbeat: new Date(), updatedAt: new Date() })
            .where(and(eq(issueReports.id, next.id), eq(issueReports.devMergeStatus, 'queued')))
            .returning({ id: issueReports.id });
        if (claimed.length === 0) return json(200, { issue: null }); // lost the race

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, next.id)).limit(1);
        return json(200, { issue: { id: issue.id, prUrl: issue.devPrUrl, branch: issue.devBranch } });
    }

    // ── Report the outcome of a merge attempt ────────────────────────────────────
    if (event.httpMethod === 'POST' && action === 'merge-result' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });

        const ok = body.ok !== false;
        const outcome = (typeof body.outcome === 'string' ? body.outcome : '').trim();

        if (ok) {
            await db.update(issueReports).set({
                devMergeStatus: 'merged',
                devMergedAt: new Date(),
                devMergeResult: outcome || 'Merged to staging.',
                devRunnerId: null,
                devRunnerHeartbeat: null,
                updatedAt: new Date(),
            }).where(eq(issueReports.id, id));

            await db.insert(issueReportMessages).values({
                issueId: id,
                authorType: 'admin',
                authorId: null,
                body: `🔀 Pull request merged to staging.${outcome ? `\n\n${outcome}` : ''}`,
                status: null,
            });

            // Advances to "Fixed & Ready to Test" (and notifies the reporter) iff no
            // migration is still pending; otherwise the run-SQL step will trigger it.
            const advanced = await maybeAdvanceToReadyToTest(db, id, event.headers);
            // Once nothing else is queued/merging, rebuild staging so the merge just made
            // is actually live — no separate "Commit to Staging" step for an admin to remember.
            await triggerStagingDeployIfDrained(db);
            return json(200, { ok: true, devMergeStatus: 'merged', advanced });
        }

        await db.update(issueReports).set({
            devMergeStatus: 'failed',
            devMergeResult: outcome || 'The merge could not be completed.',
            devRunnerId: null,
            devRunnerHeartbeat: null,
            updatedAt: new Date(),
        }).where(eq(issueReports.id, id));

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: null,
            body: `⚠️ Merge to staging failed — the pull request was NOT merged.${outcome ? `\n\n${outcome}` : ''}\n\nResolve the problem and request the merge again.`,
            status: null,
        });

        // A prior merge in this batch may have succeeded — drain check still applies so
        // it gets deployed even though this particular one failed.
        await triggerStagingDeployIfDrained(db);
        return json(200, { ok: true, devMergeStatus: 'failed' });
    }

    // ── Claim the next queued CONFLICT FIX ───────────────────────────────────────
    // A super-admin pressed "Investigate & fix conflicts" on a failed merge
    // (dev_merge_status='conflict_queued'); the runner claims it (conflict_queued →
    // conflict_resolving), merges the base branch into the fix branch, resolves any
    // conflicts with Claude Code, pushes, and retries `gh pr merge`, then reports back
    // via ?action=conflict-fix-result.
    if (event.httpMethod === 'GET' && action === 'claim-conflict-fix') {
        const [next] = await db
            .select({ id: issueReports.id })
            .from(issueReports)
            .where(eq(issueReports.devMergeStatus, 'conflict_queued'))
            .orderBy(asc(issueReports.devHandoffAt))
            .limit(1);
        if (!next) return json(200, { issue: null });

        const claimed = await db.update(issueReports)
            .set({ devMergeStatus: 'conflict_resolving', devRunnerId: runnerId(event), devRunnerHeartbeat: new Date(), updatedAt: new Date() })
            .where(and(eq(issueReports.id, next.id), eq(issueReports.devMergeStatus, 'conflict_queued')))
            .returning({ id: issueReports.id });
        if (claimed.length === 0) return json(200, { issue: null }); // lost the race

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, next.id)).limit(1);
        return json(200, {
            issue: {
                id: issue.id,
                prUrl: issue.devPrUrl,
                branch: issue.devBranch,
                description: issue.description,
                sourceLocation: issue.sourceLocation,
            },
        });
    }

    // ── Report the outcome of a conflict-resolution + merge attempt ──────────────
    if (event.httpMethod === 'POST' && action === 'conflict-fix-result' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });

        const ok = body.ok !== false;
        const outcome = (typeof body.outcome === 'string' ? body.outcome : '').trim();

        if (ok) {
            await db.update(issueReports).set({
                devMergeStatus: 'merged',
                devMergedAt: new Date(),
                devMergeResult: outcome || 'Merge conflict resolved and merged to staging.',
                devRunnerId: null,
                devRunnerHeartbeat: null,
                updatedAt: new Date(),
            }).where(eq(issueReports.id, id));

            await db.insert(issueReportMessages).values({
                issueId: id,
                authorType: 'admin',
                authorId: null,
                body: `🔧 Merge conflict investigated and resolved — pull request merged to staging.${outcome ? `\n\n${outcome}` : ''}`,
                status: null,
            });

            const advanced = await maybeAdvanceToReadyToTest(db, id, event.headers);
            await triggerStagingDeployIfDrained(db);
            return json(200, { ok: true, devMergeStatus: 'merged', advanced });
        }

        await db.update(issueReports).set({
            devMergeStatus: 'failed',
            devMergeResult: outcome || 'The merge conflict could not be resolved automatically.',
            devRunnerId: null,
            devRunnerHeartbeat: null,
            updatedAt: new Date(),
        }).where(eq(issueReports.id, id));

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: null,
            body: `⚠️ Could not automatically resolve the merge conflict.${outcome ? `\n\n${outcome}` : ''}\n\nResolve it manually, or try again.`,
            status: null,
        });

        await triggerStagingDeployIfDrained(db);
        return json(200, { ok: true, devMergeStatus: 'failed' });
    }

    // ── Runner is alive and still working a claimed fix ──────────────────────────
    // POSTed every ~60s while a Claude fix runs. Refreshes the issue's heartbeat so the reclaim
    // sweep (in ?action=claim) doesn't hand this still-in-progress issue to another runner.
    // Ownership-guarded: a zombie runner whose issue was already reclaimed + re-assigned won't
    // stamp a beat onto the new owner's row.
    if (event.httpMethod === 'POST' && action === 'fix-heartbeat' && id) {
        const rid = runnerId(event) || 'unknown-runner';
        const now = new Date();

        const beat = await db.update(issueReports)
            .set({ devRunnerHeartbeat: now, updatedAt: now })
            .where(and(
                eq(issueReports.id, id),
                eq(issueReports.devHandoffStatus, 'in_progress'),
                eq(issueReports.devRunnerId, rid),
            ))
            .returning({ id: issueReports.id });

        // beat empty → this runner no longer owns the issue (reclaimed/reassigned). Tell it to stop.
        return json(200, { ok: true, owned: beat.length > 0 });
    }

    // ── Report the outcome of a fix attempt ──────────────────────────────────────
    if (event.httpMethod === 'POST' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });

        const ok = body.ok !== false; // default to success unless explicitly false
        const summary = (typeof body.summary === 'string' ? body.summary : '').trim();
        const branch = (typeof body.branch === 'string' ? body.branch : '').trim() || null;
        const prUrl = (typeof body.prUrl === 'string' ? body.prUrl : '').trim() || null;
        const migrationSql = (typeof body.sql === 'string' ? body.sql : '').trim() || null;

        if (ok) {
            // A fix no longer jumps straight to "Fixed & Ready to Test". The PR has to be
            // merged to staging first (and any DB migration applied). So the AI confirming
            // the fix is ready moves the ticket into 'merge' with dev_merge_status='ready' —
            // a super-admin then merges it from the ticket, which is what finally advances
            // + notifies the reporter.
            const needsSql = !!migrationSql;

            await db.update(issueReports).set({
                devHandoffStatus: 'completed',
                devBranch: branch,
                devPrUrl: prUrl,
                devResult: summary || null,
                devSql: migrationSql,
                devSqlStatus: needsSql ? 'pending' : null,
                devSqlResult: null,
                devSqlRanAt: null,
                devMergeStatus: 'ready',
                devMergedAt: null,
                devMergeResult: null,
                devRunnerId: null,
                devRunnerHeartbeat: null,
                status: 'merge',
                updatedAt: new Date(),
            }).where(eq(issueReports.id, id));

            const prLine = (prUrl ? `\n\nPull request: ${prUrl}` : '') + (branch ? `\nBranch: ${branch}` : '');
            const threadBody = needsSql
                ? `✅ AI auto-fix complete — but it needs a DATABASE MIGRATION and a merge to staging.\n\n${summary || 'A fix has been produced.'}` +
                  prLine +
                  `\n\n⚠️ Review and run the SQL in this ticket, then merge the pull request to staging.`
                : `✅ AI auto-fix complete — review the pull request and merge it to staging when ready.\n\n${summary || 'A fix has been produced.'}` +
                  prLine;

            await db.insert(issueReportMessages).values({
                issueId: id,
                authorType: 'admin',
                authorId: null,
                body: threadBody,
                status: 'merge',
            });

            // The reporter is NOT pinged here — only once the fix is merged to staging
            // (and any migration applied) and the issue is genuinely ready to re-test.
            return json(200, { ok: true, status: 'merge', needsSql, devMergeStatus: 'ready' });
        }

        // Failure — surface it to the admin without bothering the reporter (status unchanged).
        await db.update(issueReports).set({
            devHandoffStatus: 'failed',
            devResult: summary || 'The AI runner could not produce a fix.',
            devRunnerId: null,
            devRunnerHeartbeat: null,
            updatedAt: new Date(),
        }).where(eq(issueReports.id, id));

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: null,
            body: `⚠️ AI auto-fix could not complete.\n\n${summary || 'No further detail was provided.'}\n\nThis issue is still "${ISSUE_STATUS_LABEL[issue.status as keyof typeof ISSUE_STATUS_LABEL] || issue.status}" — review it manually or pass it to the developer again.`,
            status: null,
        });

        return json(200, { ok: true, status: 'failed' });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
