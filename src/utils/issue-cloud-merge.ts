// src/utils/issue-cloud-merge.ts — "Merge to staging" runs in GitHub Actions, not on a laptop.
//
//   1. The admin endpoint claims the merge (compare-and-swap → dev_merge_status 'merging',
//      dev_runner_id CLOUD_RUNNER_ID, dev_runner_heartbeat = when it started) and dispatchCloudMerge
//      starts .github/workflows/merge-to-staging.yml with the issue id and the fix PR number.
//   2. The workflow checks the PR is this issue's fix branch into staging and merges it.
//   3. syncCloudMerge follows the PR and the run — when the admin opens the issue, when the list
//      loads, and on every hourly live-check run — and records the outcome:
//      dev_merge_status 'merged' (or 'failed' with GitHub's reason), a thread message,
//      maybeAdvanceToReadyToTest, and the staging rebuild once no merge is left in flight.
//
// The heartbeat is NOT refreshed while a cloud merge runs: it is the start time this module and the
// panel read; this module reports a stuck run itself, and a super-admin can force a restart after
// STALE_MERGE_MINS. A failed merge is redone by the AI fix workflow on the latest staging
// (?action=redo-fix). The old laptop runner's 'queued' state is no longer set by anything.
//
// Tokens: as issue-ai-fix.ts (GITHUB_AI_FIX_TOKEN or GITHUB_HOTFIX_TOKEN: Actions read/write,
// Pull requests read, Checks read optional).

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { CLOUD_RUNNER_ID, ghHeaders, writeToken, readToken, repoOf, ms, findWorkflowRun, findRunFailureReason, type AiFixRun } from './issue-ai-fix';
import { parsePrNumber } from './issue-fix-live';
import { maybeAdvanceToReadyToTest, triggerStagingDeployIfDrained } from './issue-reports';

type Db = ReturnType<typeof getDb>;
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text?: () => Promise<string> }>;

export const MERGE_WORKFLOW = 'merge-to-staging.yml';
export const mergeRunTitle = (issueId: number) => `Merge to staging for issue #${issueId}`;
/** No run seen this long after dispatch → failed. */
export const MERGE_NO_RUN_MINS = 20;
/** The job's own timeout is 10 min; a run still going after this is reported as stuck. */
export const MERGE_STUCK_MINS = 30;
/** Most merges one "Merge all" click starts. */
export const MERGE_BULK_MAX = 10;

/** Start the workflow. Returns an error string for the admin, or null on success. */
export async function dispatchCloudMerge(opts: { issueId: number; pr: number; token?: string; repo?: string; fetchImpl?: FetchLike }): Promise<string | null> {
    const token = opts.token ?? writeToken();
    if (!token) return 'GITHUB_AI_FIX_TOKEN (or GITHUB_HOTFIX_TOKEN) is not set in Netlify, so the merge workflow cannot be started.';
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const res = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/actions/workflows/${MERGE_WORKFLOW}/dispatches`, {
            method: 'POST',
            headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'staging', inputs: { issue_id: String(opts.issueId), pr: String(opts.pr) } }),
        });
        if (res.status === 204 || res.ok) return null;
        if (res.status === 404) return 'GitHub could not find the merge workflow (.github/workflows/merge-to-staging.yml must be on main and staging), or the token cannot see it.';
        if (res.status === 401 || res.status === 403) return 'GitHub refused the token: it needs Actions read/write on this repo.';
        return `GitHub refused to start the merge workflow (HTTP ${res.status}).`;
    } catch (e) {
        return `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export interface MergePr { url: string; state: 'open' | 'closed'; merged: boolean }

export async function getMergePr(opts: { pr: number; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<MergePr | null | 'error'> {
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const res = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/pulls/${opts.pr}`, { headers: ghHeaders(opts.token) });
        if (res.status === 404) return null;
        if (!res.ok) return 'error';
        const p = await res.json();
        return { url: String(p.html_url), state: p.state === 'open' ? 'open' : 'closed', merged: !!p.merged_at };
    } catch {
        return 'error';
    }
}

export type MergeNext = { kind: 'merged'; result: string } | { kind: 'failed'; result: string };

/** What the PR and run mean for dev_merge_status. Pure, so it can be tested. */
export function nextMergeState(input: {
    mergeStatus: string | null;
    runnerId: string | null;
    startedAt: Date | string | null;
    pr: MergePr | null;
    run: AiFixRun | null;
    failureReason?: string | null;
    now?: number;
}): MergeNext | null {
    if (input.mergeStatus !== 'merging' || input.runnerId !== CLOUD_RUNNER_ID) return null;
    const { pr, run } = input;
    const age = (input.now ?? Date.now()) - ms(input.startedAt);
    // The PR is the source of truth: merged is merged, whatever the run says.
    if (pr && pr.merged) return { kind: 'merged', result: `Merged to staging by GitHub Actions.${run ? `\nWorkflow run: ${run.url}` : ''}` };
    if (run && run.status === 'completed') {
        const why = input.failureReason || (run.conclusion === 'success'
            ? 'The merge workflow finished but the pull request is not merged.'
            : `The merge workflow did not finish (${run.conclusion || 'unknown'}).`);
        return { kind: 'failed', result: `${why}\n\nWorkflow run: ${run.url}` };
    }
    if (run && ms(input.startedAt) && age > MERGE_STUCK_MINS * 60_000) {
        return { kind: 'failed', result: `The merge workflow has been running for over ${MERGE_STUCK_MINS} minutes. Check it on GitHub, then try again: ${run.url}` };
    }
    if (!run && ms(input.startedAt) && age > MERGE_NO_RUN_MINS * 60_000) {
        return { kind: 'failed', result: `No merge workflow run appeared within ${MERGE_NO_RUN_MINS} minutes. Check Actions on GitHub (is merge-to-staging.yml on main?), then try again.` };
    }
    return null;
}

export interface MergeRow { id: number; devMergeStatus: string | null; devRunnerId: string | null; devRunnerHeartbeat: Date | string | null; devPrUrl: string | null }

/** Record the outcome. Compare-and-swap on the cloud claim; side effects only for the winner. */
export async function applyMergeState(db: Db, row: MergeRow, next: MergeNext, headers?: Record<string, string | undefined>): Promise<boolean> {
    const claim = sql`id = ${row.id} AND dev_merge_status = 'merging' AND dev_runner_id = ${CLOUD_RUNNER_ID}`;
    if (next.kind === 'merged') {
        const r = await db.execute(sql`
            UPDATE issue_reports
               SET dev_merge_status = 'merged', dev_merged_at = now(), dev_merge_result = ${next.result},
                   dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now()
             WHERE ${claim} RETURNING id`) as unknown[];
        if (!r.length) return false;
        await db.execute(sql`
            INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
            VALUES (${row.id}, 'admin', NULL, ${`🔀 Pull request merged to staging.\n\n${next.result}`}, NULL)`);
        // Same as the runner's merge report: move the issue on (unless SQL is pending), rebuild once drained.
        await maybeAdvanceToReadyToTest(db, row.id, headers);
        await triggerStagingDeployIfDrained(db);
        return true;
    }
    const r = await db.execute(sql`
        UPDATE issue_reports
           SET dev_merge_status = 'failed', dev_merge_result = ${next.result},
               dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now()
         WHERE ${claim} RETURNING id`) as unknown[];
    if (!r.length) return false;
    await db.execute(sql`
        INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
        VALUES (${row.id}, 'admin', NULL, ${`⚠️ Merge to staging failed — the pull request was NOT merged.\n\n${next.result}\n\nTry the merge again, or press “Redo fix on latest staging” to have the AI developer write it again against current staging.`}, NULL)`);
    await triggerStagingDeployIfDrained(db);
    return true;
}

/** Follow one issue's cloud merge and record any change. True when it changed something. Never throws. */
export async function syncCloudMerge(db: Db, row: MergeRow, opts: { token?: string; repo?: string; fetchImpl?: FetchLike; now?: number; headers?: Record<string, string | undefined> } = {}): Promise<boolean> {
    if (row.devMergeStatus !== 'merging' || row.devRunnerId !== CLOUD_RUNNER_ID) return false;
    const token = opts.token ?? readToken();
    if (!token) return false;
    try {
        const prNum = parsePrNumber(row.devPrUrl, repoOf(opts.repo));
        const pr = prNum ? await getMergePr({ pr: prNum, token, repo: opts.repo, fetchImpl: opts.fetchImpl }) : null;
        if (pr === 'error') return false;
        const run = pr?.merged ? null : await findWorkflowRun({ workflow: MERGE_WORKFLOW, title: mergeRunTitle(row.id), since: row.devRunnerHeartbeat, token, repo: opts.repo, fetchImpl: opts.fetchImpl });
        if (run === 'error') return false;
        const failureReason = run && run.status === 'completed'
            ? await findRunFailureReason({ runId: run.id, title: 'Merge to staging', token, repo: opts.repo, fetchImpl: opts.fetchImpl })
            : null;
        const next = nextMergeState({ mergeStatus: row.devMergeStatus, runnerId: row.devRunnerId, startedAt: row.devRunnerHeartbeat, pr, run, failureReason, now: opts.now });
        if (!next) return false;
        return await applyMergeState(db, row, next, opts.headers);
    } catch (e) {
        console.error('[issue-cloud-merge] sync failed:', e instanceof Error ? e.message : e);
        return false;
    }
}

/** Follow every cloud merge still in flight (capped). Used by the list and the hourly live check. */
export async function syncOpenCloudMerges(db: Db, opts: { token?: string; repo?: string; fetchImpl?: FetchLike; limit?: number } = {}): Promise<number> {
    if (!(opts.token ?? readToken())) return 0;
    try {
        const rows = await db.execute(sql`
            SELECT id, dev_merge_status, dev_runner_id, dev_runner_heartbeat, dev_pr_url FROM issue_reports
             WHERE dev_merge_status = 'merging' AND dev_runner_id = ${CLOUD_RUNNER_ID}
             ORDER BY dev_runner_heartbeat ASC NULLS LAST LIMIT ${opts.limit ?? 10}`) as Array<{ id: number; dev_merge_status: string; dev_runner_id: string; dev_runner_heartbeat: Date | string | null; dev_pr_url: string | null }>;
        // One at a time: each merge may fire the staging rebuild once nothing else is in flight.
        let n = 0;
        for (const r of rows) {
            if (await syncCloudMerge(db, { id: Number(r.id), devMergeStatus: r.dev_merge_status, devRunnerId: r.dev_runner_id, devRunnerHeartbeat: r.dev_runner_heartbeat, devPrUrl: r.dev_pr_url }, opts)) n++;
        }
        return n;
    } catch (e) {
        console.error('[issue-cloud-merge] syncOpenCloudMerges failed:', e instanceof Error ? e.message : e);
        return 0;
    }
}
