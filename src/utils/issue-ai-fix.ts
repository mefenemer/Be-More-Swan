// src/utils/issue-ai-fix.ts — "Pass to Developer" runs in GitHub Actions, not on a laptop.
//
// The laptop runner (scripts/dev-issue-fixer.mjs) only moved when someone's machine was on. Now:
//
//   1. The admin endpoint claims the issue (compare-and-swap → dev_handoff_status 'in_progress',
//      dev_runner_id CLOUD_RUNNER_ID) and dispatchAiFix starts .github/workflows/ai-fix.yml with
//      the issue id and a sanitised, capped copy of the issue text (buildAiFixIssueText).
//   2. The workflow runs Claude Code, pushes `ai-fix/issue-<id>` and opens a PR into staging, with
//      the summary and any proposed SQL in the PR body.
//   3. syncAiFix follows the run and the PR — when the admin opens the issue, when the list loads,
//      and on every hourly live-check run — and records the result on the same columns the laptop
//      runner used (dev_branch, dev_pr_url, dev_result, dev_sql, dev_merge_status 'ready',
//      status 'merge'), so the issue panel, the list and the board work unchanged.
//
// 'queued' is no longer set by anything here: it is the laptop runner's queue. The laptop's claim
// endpoint skips cloud rows (admin-issue-handoff.ts), so a laptop left running can't reclaim them.
// Merging to staging is issue-cloud-merge.ts; conflict fixes still go through the laptop runner.
//
// The issue text is untrusted (a customer, or a model, wrote it). It travels only as a workflow
// input that the workflow reads through an env var, and Claude is told it is data.
//
// Tokens: GITHUB_AI_FIX_TOKEN, else GITHUB_HOTFIX_TOKEN (fine-grained, this repo: Actions read/write,
// Pull requests read; Checks read is optional and lets a failure show the workflow's reason). Reads
// fall back to GITHUB_FIX_CHECK_TOKEN.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text?: () => Promise<string> }>;

export const AI_FIX_WORKFLOW = 'ai-fix.yml';
/** The workflow runs from, checks out, and opens its PR into this branch. */
export const AI_FIX_BASE = 'staging';
/** dev_runner_id on an issue the cloud workflow holds. Shown in the panel as the "runner". */
export const CLOUD_RUNNER_ID = 'GitHub Actions';
/** No run seen this long after dispatch → failed. */
export const AI_FIX_NO_RUN_MINS = 20;
/** The job's own timeout is 40 min; past this a run that never finished is reported as stuck. */
export const AI_FIX_STUCK_MINS = 60;
/** Most issues one bulk click starts at once (each is a Claude Code run that costs money). */
export const AI_FIX_BULK_MAX = 10;
/** The issue text sent to the workflow is capped here (the workflow refuses over 12000). */
export const AI_FIX_TEXT_MAX = 8000;

export const SQL_START = '---SQL-MIGRATION-START---';
export const SQL_END = '---SQL-MIGRATION-END---';

const DEFAULT_REPO = 'mefenemer/Be-More-Swan';
export const repoOf = (r?: string) => r || process.env.GITHUB_REPO || DEFAULT_REPO;
export const aiFixBranch = (issueId: number) => `ai-fix/issue-${issueId}`;
export const aiFixRunTitle = (issueId: number) => `AI fix for issue #${issueId}`;

export function ghHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'issue-ai-fix',
    };
}
export const writeToken = () => process.env.GITHUB_AI_FIX_TOKEN || process.env.GITHUB_HOTFIX_TOKEN || '';
export const readToken = () => writeToken() || process.env.GITHUB_FIX_CHECK_TOKEN || '';

/** Strip control characters (keeping newlines and tabs) and cap the length. */
export function sanitiseIssueText(s: string | null | undefined, max = AI_FIX_TEXT_MAX): string {
    const clean = String(s ?? '')
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, '')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
    return clean.length > max ? `${clean.slice(0, max - 20).trimEnd()}\n…(cut short)` : clean;
}

export interface ThreadMessage { authorType: string; body: string | null; createdAt?: Date | string | null }

/**
 * What the AI developer is told about the issue. No reporter name or email: only what describes the
 * bug. On a retry the latest thread (the reporter's "it still doesn't work", the last attempt's
 * summary) matters most, so the newest messages are kept when the cap bites.
 */
export function buildAiFixIssueText(issue: { id: number; description: string | null; sourceLocation?: string | null; sourceUrl?: string | null; hasImage?: boolean }, thread: ThreadMessage[] = []): string {
    const head = [
        `Issue #${issue.id}`,
        `Location in app: ${sanitiseIssueText(issue.sourceLocation, 200) || 'unknown'}`,
        issue.sourceUrl ? `Page: ${sanitiseIssueText(issue.sourceUrl, 300)}` : '',
        issue.hasImage ? '(The reporter attached a screenshot. It is not available here.)' : '',
        '',
        'Description:',
        sanitiseIssueText(issue.description, 4000) || '(no description provided)',
    ].filter((l, i) => l !== '' || i === 4).join('\n');

    const msgs = thread.filter((m) => m && m.body).map((m) => `[${m.authorType === 'user' ? 'reporter' : 'team'}] ${sanitiseIssueText(m.body, 1200)}`);
    if (!msgs.length) return sanitiseIssueText(head);
    const intro = '\n\nTicket thread (oldest first). The latest reporter message is the current problem; do not repeat an approach the thread says failed:\n';
    let budget = AI_FIX_TEXT_MAX - head.length - intro.length - 40;
    const kept: string[] = [];
    for (let i = msgs.length - 1; i >= 0 && budget > 0; i--) {
        if (msgs[i].length + 2 > budget) break;
        kept.unshift(msgs[i]);
        budget -= msgs[i].length + 2;
    }
    const dropped = msgs.length - kept.length;
    return sanitiseIssueText(head + intro + (dropped ? `(${dropped} older message${dropped === 1 ? '' : 's'} left out)\n\n` : '') + kept.join('\n\n'));
}

/** Start the workflow. Returns an error string for the admin, or null on success. */
export async function dispatchAiFix(opts: { issueId: number; issueText: string; token?: string; repo?: string; fetchImpl?: FetchLike }): Promise<string | null> {
    const token = opts.token ?? writeToken();
    if (!token) return 'GITHUB_AI_FIX_TOKEN (or GITHUB_HOTFIX_TOKEN) is not set in Netlify, so the AI fix workflow cannot be started.';
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const res = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/actions/workflows/${AI_FIX_WORKFLOW}/dispatches`, {
            method: 'POST',
            headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: AI_FIX_BASE, inputs: { issue_id: String(opts.issueId), issue_text: sanitiseIssueText(opts.issueText) || `Issue #${opts.issueId}` } }),
        });
        if (res.status === 204 || res.ok) return null;
        if (res.status === 404) return 'GitHub could not find the AI fix workflow (.github/workflows/ai-fix.yml must be on main and staging), or the token cannot see it.';
        if (res.status === 401 || res.status === 403) return 'GitHub refused the token: it needs Actions read/write on this repo.';
        if (res.status === 422) return 'GitHub refused the workflow inputs (HTTP 422). Is ai-fix.yml on staging the same version as on main?';
        return `GitHub refused to start the AI fix workflow (HTTP ${res.status}).`;
    } catch (e) {
        return `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export interface AiFixPr { url: string; number: number; state: 'open' | 'closed'; merged: boolean; body: string; branch: string }
export interface AiFixRun { id: number; status: string; conclusion: string | null; url: string }

const SLACK_MS = 2 * 60_000;
export const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

/**
 * This attempt's PR, found by its branch. A PR from an earlier attempt only counts if it was opened,
 * or (still open) updated, since this attempt started — the workflow edits an open PR in place.
 */
export async function findAiFixPr(opts: { issueId: number; since: Date | string | null; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<AiFixPr | null | 'error'> {
    const repo = repoOf(opts.repo);
    const owner = repo.split('/')[0];
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    const since = ms(opts.since) - SLACK_MS;
    try {
        const res = await f(`https://api.github.com/repos/${repo}/pulls?state=all&base=${AI_FIX_BASE}&head=${encodeURIComponent(`${owner}:${aiFixBranch(opts.issueId)}`)}&per_page=10`, { headers: ghHeaders(opts.token) });
        if (!res.ok) return 'error';
        const list = await res.json();
        if (!Array.isArray(list)) return 'error';
        const pr = list
            .filter((p: any) => ms(p.created_at) >= since || (p.state === 'open' && ms(p.updated_at) >= since))
            .sort((a: any, b: any) => (b.number || 0) - (a.number || 0))[0];
        if (!pr) return null;
        return {
            url: String(pr.html_url), number: Number(pr.number), state: pr.state === 'open' ? 'open' : 'closed',
            merged: !!pr.merged_at, body: String(pr.body || ''), branch: String(pr.head?.ref || aiFixBranch(opts.issueId)),
        };
    } catch {
        return 'error';
    }
}

/** A workflow's newest dispatch run with this run-name, started no earlier than `since` (less a little slack). */
export async function findWorkflowRun(opts: { workflow: string; title: string; since: Date | string | null; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<AiFixRun | null | 'error'> {
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    const since = ms(opts.since) - SLACK_MS;
    try {
        const res = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/actions/workflows/${opts.workflow}/runs?event=workflow_dispatch&per_page=50`, { headers: ghHeaders(opts.token) });
        if (!res.ok) return 'error';
        const runs = (await res.json())?.workflow_runs;
        const run = Array.isArray(runs) ? runs.find((r: any) => r.display_title === opts.title && ms(r.created_at) >= since) : null;
        return run ? { id: Number(run.id), status: String(run.status), conclusion: run.conclusion ?? null, url: String(run.html_url) } : null;
    } catch {
        return 'error';
    }
}

/** This attempt's AI fix run. */
export function findAiFixRun(opts: { issueId: number; since: Date | string | null; token: string; repo?: string; fetchImpl?: FetchLike }) {
    return findWorkflowRun({ ...opts, workflow: AI_FIX_WORKFLOW, title: aiFixRunTitle(opts.issueId) });
}

/**
 * A run's own reason for failing: its error annotation with this title (the workflows' "Say why it
 * failed" step). Best-effort: needs Checks read on the token. Model-written text may be in it, so it
 * is only ever shown escaped.
 */
export async function findRunFailureReason(opts: { runId: number; title: string; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<string | null> {
    const repo = repoOf(opts.repo);
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const jr = await f(`https://api.github.com/repos/${repo}/actions/runs/${opts.runId}/jobs?per_page=5`, { headers: ghHeaders(opts.token) });
        if (!jr.ok) return null;
        const job = (await jr.json())?.jobs?.[0];
        const checkRunId = job?.check_run_url ? String(job.check_run_url).split('/').pop() : job?.id;
        if (!checkRunId) return null;
        const ar = await f(`https://api.github.com/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=20`, { headers: ghHeaders(opts.token) });
        if (!ar.ok) return null;
        const notes = await ar.json();
        const mine = Array.isArray(notes) ? notes.find((a: any) => a.title === opts.title && a.message) : null;
        return mine ? sanitiseIssueText(String(mine.message), 3000) : null;
    } catch {
        return null;
    }
}

/** The summary and SQL the workflow wrote into the PR body. */
export function parseAiFixPrBody(body: string | null | undefined): { summary: string | null; sql: string | null } {
    const b = String(body || '');
    const sm = /<!-- ai-fix:summary:start -->\s*([\s\S]*?)\s*<!-- ai-fix:summary:end -->/.exec(b);
    const summary = sm ? sm[1].trim() || null : null;
    let sqlText: string | null = null;
    const a = b.indexOf(SQL_START), e = b.indexOf(SQL_END);
    if (a !== -1 && e > a) {
        sqlText = b.slice(a + SQL_START.length, e).trim()
            .replace(/^`{3,}[a-z]*\s*\n?/i, '').replace(/\n?`{3,}\s*$/, '').trim() || null;
    }
    return { summary, sql: sqlText };
}

export type AiFixNext =
    | { kind: 'completed'; branch: string; prUrl: string; summary: string; sql: string | null }
    | { kind: 'failed'; result: string }
    | { kind: 'running'; result: string };

/** What the run and PR mean for the issue. Pure, so it can be tested. */
export function nextAiFixState(input: {
    current: string | null;
    runnerId: string | null;
    startedAt: Date | string | null;
    pr: AiFixPr | null;
    run: AiFixRun | null;
    failureReason?: string | null;
    now?: number;
}): AiFixNext | null {
    const { current, runnerId, pr, run } = input;
    if (current !== 'in_progress' || runnerId !== CLOUD_RUNNER_ID) return null;
    const now = input.now ?? Date.now();
    const age = now - ms(input.startedAt);

    if (pr && (pr.state === 'open' || pr.merged)) {
        const { summary, sql: sqlText } = parseAiFixPrBody(pr.body);
        return { kind: 'completed', branch: pr.branch, prUrl: pr.url, summary: summary || 'A fix has been produced.', sql: sqlText };
    }
    if (pr && pr.state === 'closed') {
        return { kind: 'failed', result: `The AI fix PR was closed without merging: ${pr.url}\nPass it to the developer again to retry.` };
    }
    if (run && run.status === 'completed') {
        const why = input.failureReason || (run.conclusion === 'success'
            ? 'The workflow finished but no pull request was found.'
            : `The AI fix workflow did not finish (${run.conclusion || 'unknown'}).`);
        return { kind: 'failed', result: `${why}\n\nWorkflow run: ${run.url}` };
    }
    if (run) {
        if (ms(input.startedAt) && age > AI_FIX_STUCK_MINS * 60_000) {
            return { kind: 'failed', result: `The AI fix workflow has been running for over ${AI_FIX_STUCK_MINS} minutes. Check it on GitHub, then try again: ${run.url}` };
        }
        return { kind: 'running', result: `Claude Code is working on it in GitHub Actions.\nWorkflow run: ${run.url}` };
    }
    if (ms(input.startedAt) && age > AI_FIX_NO_RUN_MINS * 60_000) {
        return { kind: 'failed', result: `No AI fix workflow run appeared within ${AI_FIX_NO_RUN_MINS} minutes. Check Actions on GitHub (is ANTHROPIC_API_KEY set, is ai-fix.yml on main?), then try again.` };
    }
    return null;
}

export interface AiFixRow { id: number; devHandoffStatus: string | null; devRunnerId: string | null; devHandoffAt: Date | string | null; devResult?: string | null; status?: string | null }

/** Record the outcome. Compare-and-swap on the cloud claim, so a re-pass or a hand edit wins. */
export async function applyAiFixState(db: Db, row: AiFixRow, next: AiFixNext): Promise<boolean> {
    const claim = sql`id = ${row.id} AND dev_handoff_status = 'in_progress' AND dev_runner_id = ${CLOUD_RUNNER_ID}`;
    if (next.kind === 'running') {
        // Keep the panel's "working for" fresh and show the run link. Skips the write when nothing changed.
        const r = await db.execute(sql`
            UPDATE issue_reports SET dev_result = ${next.result}, dev_runner_heartbeat = now()
             WHERE ${claim} AND (dev_result IS DISTINCT FROM ${next.result} OR dev_runner_heartbeat < now() - interval '5 minutes')
            RETURNING id`) as unknown[];
        return r.length > 0;
    }
    if (next.kind === 'failed') {
        const r = await db.execute(sql`
            UPDATE issue_reports
               SET dev_handoff_status = 'failed', dev_result = ${next.result},
                   dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now()
             WHERE ${claim} RETURNING id, status`) as Array<{ id: number; status: string }>;
        if (!r.length) return false;
        await db.execute(sql`
            INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
            VALUES (${row.id}, 'admin', NULL, ${`⚠️ AI auto-fix could not complete.\n\n${next.result}\n\nIts status is unchanged (${String(r[0].status).replace(/_/g, ' ')}). Review it by hand or pass it to the developer again.`}, NULL)`);
        return true;
    }
    const needsSql = !!next.sql;
    const r = await db.execute(sql`
        UPDATE issue_reports
           SET dev_handoff_status = 'completed', dev_branch = ${next.branch}, dev_pr_url = ${next.prUrl},
               dev_result = ${next.summary}, dev_sql = ${next.sql},
               dev_sql_status = ${needsSql ? 'pending' : null}, dev_sql_result = NULL, dev_sql_ran_at = NULL,
               dev_merge_status = 'ready', dev_merged_at = NULL, dev_merge_result = NULL,
               dev_runner_id = NULL, dev_runner_heartbeat = NULL, status = 'merge', updated_at = now()
         WHERE ${claim} RETURNING id`) as unknown[];
    if (!r.length) return false;
    const prLine = `\n\nPull request: ${next.prUrl}\nBranch: ${next.branch}`;
    const body = needsSql
        ? `✅ AI auto-fix complete — but it needs a DATABASE MIGRATION and a merge to staging.\n\n${next.summary}${prLine}\n\n⚠️ Review and run the SQL in this ticket, then merge the pull request to staging.`
        : `✅ AI auto-fix complete — review the pull request and merge it to staging when ready.\n\n${next.summary}${prLine}`;
    // The reporter is not told here: only once the fix is live (issue-fix-live.ts).
    await db.execute(sql`
        INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
        VALUES (${row.id}, 'admin', NULL, ${body}, 'merge')`);
    return true;
}

/** Follow one issue's cloud fix and record any change. True when it changed something. Never throws. */
export async function syncAiFix(db: Db, row: AiFixRow, opts: { token?: string; repo?: string; fetchImpl?: FetchLike; now?: number } = {}): Promise<boolean> {
    if (row.devHandoffStatus !== 'in_progress' || row.devRunnerId !== CLOUD_RUNNER_ID) return false;
    const token = opts.token ?? readToken();
    if (!token) return false;
    try {
        const base = { issueId: row.id, since: row.devHandoffAt, token, repo: opts.repo, fetchImpl: opts.fetchImpl };
        const pr = await findAiFixPr(base);
        if (pr === 'error') return false;
        const run = pr ? null : await findAiFixRun(base);
        if (run === 'error') return false;
        const failureReason = run && run.status === 'completed'
            ? await findRunFailureReason({ runId: run.id, title: 'AI fix', token, repo: opts.repo, fetchImpl: opts.fetchImpl })
            : null;
        const next = nextAiFixState({ current: row.devHandoffStatus, runnerId: row.devRunnerId, startedAt: row.devHandoffAt, pr, run, failureReason, now: opts.now });
        if (!next) return false;
        return await applyAiFixState(db, row, next);
    } catch (e) {
        console.error('[issue-ai-fix] sync failed:', e instanceof Error ? e.message : e);
        return false;
    }
}

/** Follow every cloud fix still in flight (capped). Used by the list and the hourly live check. */
export async function syncOpenAiFixes(db: Db, opts: { token?: string; repo?: string; fetchImpl?: FetchLike; limit?: number } = {}): Promise<number> {
    if (!(opts.token ?? readToken())) return 0;
    try {
        const rows = await db.execute(sql`
            SELECT id, dev_handoff_status, dev_runner_id, dev_handoff_at FROM issue_reports
             WHERE dev_handoff_status = 'in_progress' AND dev_runner_id = ${CLOUD_RUNNER_ID}
             ORDER BY dev_handoff_at ASC NULLS LAST LIMIT ${opts.limit ?? 10}`) as Array<{ id: number; dev_handoff_status: string; dev_runner_id: string; dev_handoff_at: Date | string | null }>;
        const done = await Promise.all(rows.map((r) => syncAiFix(db, {
            id: Number(r.id), devHandoffStatus: r.dev_handoff_status, devRunnerId: r.dev_runner_id, devHandoffAt: r.dev_handoff_at,
        }, opts)));
        return done.filter(Boolean).length;
    } catch (e) {
        console.error('[issue-ai-fix] syncOpenAiFixes failed:', e instanceof Error ? e.message : e);
        return 0;
    }
}
