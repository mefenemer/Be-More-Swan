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
// Auth: header `x-handoff-token: <DEV_HANDOFF_TOKEN>` or `Authorization: Bearer <token>`.
// If DEV_HANDOFF_TOKEN is unset the endpoint is disabled (503) — the feature is opt-in.

import { Handler } from '@netlify/functions';
import { and, eq, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { issueReports, issueReportMessages, users, devRunnerStatus } from '../../db/schema';
import { ISSUE_STATUS_LABEL, maybeAdvanceToReadyToTest } from '../../src/utils/issue-reports';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

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

        return json(200, { ok: true, devMergeStatus: 'failed' });
    }

    // ── Runner hit its Claude session/usage limit ────────────────────────────────
    // The runner can't produce ANY fix while its Claude Code CLI is rate-limited, so instead
    // of burning the issue as 'failed' (which just fails again on re-queue), it reports the
    // block here. We: (1) park the runner as 'session_limited'; (2) re-queue the issue so it's
    // retried once a funded Claude account is logged in and the runner resumes; (3) thread a
    // clear "log in with credit, then Resume" instruction for the admin. The runner then polls
    // ?action=resume-check and waits — it does NOT keep claiming.
    if (event.httpMethod === 'POST' && action === 'report-blocked' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const rid = runnerId(event) || 'unknown-runner';
        const message = (typeof body.message === 'string' ? body.message : '').trim().slice(0, 1000) || 'Claude session/usage limit reached.';
        const resetHint = (typeof body.resetHint === 'string' ? body.resetHint : '').trim().slice(0, 200) || null;
        const activeAccount = (typeof body.activeAccount === 'string' ? body.activeAccount : '').trim().slice(0, 200) || null;
        const now = new Date();

        await db.insert(devRunnerStatus).values({
            runnerId: rid, state: 'session_limited', message, resetHint,
            blockedIssueId: id, resumeRequested: false, lastProbeResult: null, activeAccount,
            blockedAt: now, lastSeenAt: now, updatedAt: now,
        }).onConflictDoUpdate({
            target: devRunnerStatus.runnerId,
            set: {
                state: 'session_limited', message, resetHint, blockedIssueId: id,
                resumeRequested: false, lastProbeResult: null, activeAccount, blockedAt: now, lastSeenAt: now, updatedAt: now,
            },
        });

        // Re-queue the issue so it isn't lost; clear the (now paused) runner's claim.
        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (issue) {
            await db.update(issueReports).set({
                devHandoffStatus: 'queued', devRunnerId: null, devRunnerHeartbeat: null, updatedAt: now,
            }).where(eq(issueReports.id, id));

            await db.insert(issueReportMessages).values({
                issueId: id,
                authorType: 'admin',
                authorId: null,
                body: `⏸️ AI auto-fix paused — the runner's Claude account hit its session limit${resetHint ? ` (resets ${resetHint})` : ''}.\n\nLog into a Claude account with credit on the runner machine, then press "I've logged in — Resume runner" in the banner at the top of the Issue Reports list (also shown in the 🤖 Runner panel). This issue is queued and will be retried automatically once the runner resumes — no need to re-submit it.`,
                status: null,
            });
        }

        return json(200, { ok: true, state: 'session_limited', runnerId: rid });
    }

    // ── Runner asks whether it may resume (polled while paused) ───────────────────
    // Doubles as a liveness ping (updates last_seen_at). Returns resume:true once a super-admin
    // has pressed "Resume runner" in the portal after re-logging in on the runner machine.
    if (event.httpMethod === 'GET' && action === 'resume-check') {
        const rid = runnerId(event) || 'unknown-runner';
        const now = new Date();
        // The runner sends its currently-logged-in Claude account on every poll, so the
        // paused banner shows the live session while the admin switches logins.
        const account = (qs.account || '').toString().trim().slice(0, 200) || null;
        const [row] = await db.select().from(devRunnerStatus).where(eq(devRunnerStatus.runnerId, rid)).limit(1);
        if (row) {
            await db.update(devRunnerStatus)
                .set({ lastSeenAt: now, ...(account ? { activeAccount: account } : {}) })
                .where(eq(devRunnerStatus.runnerId, rid));
        }
        return json(200, { resume: !!row?.resumeRequested, state: row?.state || 'ok' });
    }

    // ── Runner reports the result of verifying the new login ──────────────────────
    // After the admin presses Resume, the runner runs a cheap probe against Claude. ok:true →
    // the new account works, so we clear the block (the re-queued issue gets re-claimed). ok:false
    // → the login didn't actually switch / still limited; we consume the resume request and record
    // why, so the admin can log in properly and press Resume again.
    if (event.httpMethod === 'POST' && action === 'resume-ack') {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const rid = runnerId(event) || 'unknown-runner';
        const ok = body.ok === true;
        const probeMsg = (typeof body.message === 'string' ? body.message : '').trim().slice(0, 1000) || (ok ? 'Claude login verified — runner resumed.' : 'The Claude account is still rate-limited.');
        const activeAccount = (typeof body.activeAccount === 'string' ? body.activeAccount : '').trim().slice(0, 200) || null;
        const now = new Date();

        const [row] = await db.select().from(devRunnerStatus).where(eq(devRunnerStatus.runnerId, rid)).limit(1);

        await db.insert(devRunnerStatus).values({
            runnerId: rid,
            state: ok ? 'ok' : 'session_limited',
            message: ok ? null : (row?.message || null),
            resetHint: ok ? null : (row?.resetHint || null),
            blockedIssueId: ok ? null : (row?.blockedIssueId ?? null),
            resumeRequested: false, lastProbeResult: probeMsg, activeAccount, lastSeenAt: now, updatedAt: now,
        }).onConflictDoUpdate({
            target: devRunnerStatus.runnerId,
            set: {
                state: ok ? 'ok' : 'session_limited',
                ...(ok ? { message: null, resetHint: null, blockedIssueId: null, blockedAt: null } : {}),
                resumeRequested: false, lastProbeResult: probeMsg,
                ...(activeAccount ? { activeAccount } : {}),
                lastSeenAt: now, updatedAt: now,
            },
        });

        // Thread the probe outcome on the issue the runner was blocked on, so the admin sees it.
        const blockedId = row?.blockedIssueId ?? null;
        if (blockedId) {
            await db.insert(issueReportMessages).values({
                issueId: blockedId,
                authorType: 'admin',
                authorId: null,
                body: ok
                    ? `▶️ Runner resumed — the new Claude login was verified${activeAccount ? ` (active session: ${activeAccount})` : ''}. This issue will be picked up again shortly.`
                    : `⚠️ Resume failed — the Claude account is still rate-limited or the login didn't switch on the runner machine.\n\n${probeMsg}${activeAccount ? `\nActive Claude session on the runner: ${activeAccount}` : ''}\n\nLog into a Claude account with credit on the runner machine, then press "I've logged in — Resume runner" again.`,
                status: null,
            });
        }

        return json(200, { ok: true, state: ok ? 'ok' : 'session_limited' });
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
            // merged to staging first (and any DB migration applied). So we park the issue
            // at 'fix_in_progress' with dev_merge_status='ready' — a super-admin then merges
            // it from the ticket, which is what finally advances + notifies the reporter.
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
                status: 'fix_in_progress',
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
                status: 'fix_in_progress',
            });

            // The reporter is NOT pinged here — only once the fix is merged to staging
            // (and any migration applied) and the issue is genuinely ready to re-test.
            return json(200, { ok: true, status: 'fix_in_progress', needsSql, devMergeStatus: 'ready' });
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
