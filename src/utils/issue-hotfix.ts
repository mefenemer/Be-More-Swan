// src/utils/issue-hotfix.ts — "Open hotfix PR": ship ONE issue's fix to production on its own.
//
// Replaces "Push to prod", which promoted ALL of staging to main through the developer's laptop
// runner, so unreviewed work on staging shipped with the fix. Now:
//
//   1. requestHotfix starts .github/workflows/hotfix-pr.yml (workflow_dispatch). It copies just the
//      fix PR's merge commit onto `hotfix/issue-<id>` cut from main and opens a PR into main.
//   2. A person reviews and merges that PR on GitHub, under main's ruleset and required checks.
//   3. syncHotfix follows it — when the admin opens the issue, and on every hourly live-check run —
//      and records the PR, a failure, or the merge on the dev_prod_* columns.
//   4. The live check (issue-fix-live.ts) tells the reporter once the prod deploy contains the
//      hotfix PR's merge commit.
//
// dev_prod_status: 'hotfix_requested' (workflow started) → 'hotfix_open' (PR waiting for review)
// → 'promoted' (merged into main) | 'failed' (see dev_prod_result). The legacy 'queued' /
// 'promoting' values belonged to the laptop runner's claim-promote, which nothing queues any more.
//
// Engineering steps here are not threaded to the customer: they hear once, when the fix is live.
//
// Tokens: GITHUB_HOTFIX_TOKEN (fine-grained, this repo: Actions read/write, Pull requests read) to
// start and follow the workflow; reads fall back to GITHUB_FIX_CHECK_TOKEN.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { parsePrNumber } from './issue-fix-live';

type Db = ReturnType<typeof getDb>;
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text?: () => Promise<string> }>;

export const HOTFIX_WORKFLOW = 'hotfix-pr.yml';
export const HOTFIX_STATUSES = ['hotfix_requested', 'hotfix_open'] as const;
/** A run that hasn't produced a PR or a failure after this long is reported as stuck. */
export const HOTFIX_STUCK_MINS = 30;

const DEFAULT_REPO = 'mefenemer/Be-More-Swan';
const repoOf = (r?: string) => r || process.env.GITHUB_REPO || DEFAULT_REPO;
export const hotfixBranch = (issueId: number) => `hotfix/issue-${issueId}`;
export const hotfixRunTitle = (issueId: number) => `Hotfix PR for issue #${issueId}`;

function headers(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'issue-hotfix',
    };
}
const writeToken = () => process.env.GITHUB_HOTFIX_TOKEN || '';
const readToken = () => process.env.GITHUB_HOTFIX_TOKEN || process.env.GITHUB_FIX_CHECK_TOKEN || '';

/** The hotfix PR's number from the URL syncHotfix stored in dev_prod_result ("Hotfix PR: <url>"). */
export function hotfixPrFromResult(result: string | null | undefined, repo?: string): number | null {
    const m = /Hotfix PR: (https:\/\/github\.com\/\S+\/pull\/\d+)/.exec(result || '');
    return m ? parsePrNumber(m[1], repoOf(repo)) : null;
}

/** Start the workflow. Returns an error string for the admin, or null on success. */
export async function dispatchHotfix(opts: { issueId: number; fixPr: number; token?: string; repo?: string; fetchImpl?: FetchLike }): Promise<string | null> {
    const token = opts.token ?? writeToken();
    if (!token) return 'GITHUB_HOTFIX_TOKEN is not set in Netlify, so the hotfix workflow cannot be started.';
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const res = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/actions/workflows/${HOTFIX_WORKFLOW}/dispatches`, {
            method: 'POST',
            headers: { ...headers(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'main', inputs: { issue_id: String(opts.issueId), fix_pr: String(opts.fixPr) } }),
        });
        if (res.status === 204 || res.ok) return null;
        if (res.status === 404) return 'GitHub could not find the hotfix workflow on main (merge .github/workflows/hotfix-pr.yml first), or the token cannot see it.';
        if (res.status === 401 || res.status === 403) return 'GitHub refused the token: it needs Actions read/write on this repo.';
        return `GitHub refused to start the workflow (HTTP ${res.status}).`;
    } catch (e) {
        return `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`;
    }
}

export interface HotfixPr { url: string; number: number; state: 'open' | 'closed'; merged: boolean; mergeSha: string | null }

/** The hotfix PR for this issue (newest first), found by its branch name. */
export async function findHotfixPr(opts: { issueId: number; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<HotfixPr | null | 'error'> {
    const repo = repoOf(opts.repo);
    const owner = repo.split('/')[0];
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const res = await f(`https://api.github.com/repos/${repo}/pulls?state=all&base=main&head=${encodeURIComponent(`${owner}:${hotfixBranch(opts.issueId)}`)}&per_page=5`, { headers: headers(opts.token) });
        if (!res.ok) return 'error';
        const list = await res.json();
        const pr = Array.isArray(list) ? list.sort((a: any, b: any) => (b.number || 0) - (a.number || 0))[0] : null;
        if (!pr) return null;
        return { url: String(pr.html_url), number: Number(pr.number), state: pr.state === 'open' ? 'open' : 'closed', merged: !!pr.merged_at, mergeSha: pr.merge_commit_sha || null };
    } catch {
        return 'error';
    }
}

/** The newest workflow run for this issue, matched by its run-name. */
export async function findHotfixRun(opts: { issueId: number; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<{ status: string; conclusion: string | null; url: string } | null | 'error'> {
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    try {
        const res = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/actions/workflows/${HOTFIX_WORKFLOW}/runs?event=workflow_dispatch&per_page=30`, { headers: headers(opts.token) });
        if (!res.ok) return 'error';
        const runs = (await res.json())?.workflow_runs;
        const run = Array.isArray(runs) ? runs.find((r: any) => r.display_title === hotfixRunTitle(opts.issueId)) : null;
        return run ? { status: String(run.status), conclusion: run.conclusion ?? null, url: String(run.html_url) } : null;
    } catch {
        return 'error';
    }
}

/** What the hotfix's GitHub state means for dev_prod_*. Pure, so it can be tested. */
export function nextHotfixState(input: {
    current: string | null;
    requestedAt: Date | string | null;
    pr: HotfixPr | null;
    run: { status: string; conclusion: string | null; url: string } | null;
    now?: number;
}): { status: string; result: string } | null {
    const { current, pr, run } = input;
    if (!current || !(HOTFIX_STATUSES as readonly string[]).includes(current)) return null;
    if (pr && pr.merged) return { status: 'promoted', result: `Hotfix PR: ${pr.url}\nMerged into main. The reporter is told once the prod deploy contains it.` };
    if (pr && pr.state === 'open') return { status: 'hotfix_open', result: `Hotfix PR: ${pr.url}\nOpen — review and merge it on GitHub.` };
    if (pr && pr.state === 'closed') return { status: 'failed', result: `Hotfix PR: ${pr.url}\nClosed without merging. Open a new hotfix PR to try again, or ship it with the next staging → main PR.` };
    if (run && run.status === 'completed' && run.conclusion !== 'success') {
        return { status: 'failed', result: `The hotfix workflow failed (${run.conclusion || 'unknown'}). Its log says why — most often the fix depends on something only on staging: ${run.url}` };
    }
    const started = input.requestedAt ? new Date(input.requestedAt).getTime() : 0;
    if (current === 'hotfix_requested' && started && (input.now ?? Date.now()) - started > HOTFIX_STUCK_MINS * 60_000 && !run) {
        return { status: 'failed', result: `No hotfix workflow run appeared within ${HOTFIX_STUCK_MINS} minutes. Check Actions on GitHub, then try again.` };
    }
    return null;
}

/**
 * Follow one issue's hotfix on GitHub and record any change (compare-and-swap on the status read).
 * Returns true when it changed something. Never throws.
 */
export async function syncHotfix(db: Db, row: { id: number; devProdStatus: string | null; devProdAt: Date | string | null }, opts: { token?: string; repo?: string; fetchImpl?: FetchLike } = {}): Promise<boolean> {
    if (!row.devProdStatus || !(HOTFIX_STATUSES as readonly string[]).includes(row.devProdStatus)) return false;
    const token = opts.token ?? readToken();
    if (!token) return false;
    try {
        const pr = await findHotfixPr({ issueId: row.id, token, repo: opts.repo, fetchImpl: opts.fetchImpl });
        if (pr === 'error') return false;
        const run = pr ? null : await findHotfixRun({ issueId: row.id, token, repo: opts.repo, fetchImpl: opts.fetchImpl });
        if (run === 'error') return false;
        const next = nextHotfixState({ current: row.devProdStatus, requestedAt: row.devProdAt, pr, run });
        if (!next) return false;
        // The WHERE skips a write when nothing changed (e.g. a PR still open on every hourly run).
        const changed = await db.execute(sql`
            UPDATE issue_reports
               SET dev_prod_status = ${next.status}, dev_prod_result = ${next.result},
                   dev_prod_at = CASE WHEN ${next.status} = 'promoted' THEN now() ELSE dev_prod_at END,
                   updated_at = now()
             WHERE id = ${row.id} AND dev_prod_status = ${row.devProdStatus}
               AND (dev_prod_status IS DISTINCT FROM ${next.status} OR dev_prod_result IS DISTINCT FROM ${next.result})
            RETURNING id`) as unknown[];
        return changed.length > 0;
    } catch (e) {
        console.error('[issue-hotfix] sync failed:', e instanceof Error ? e.message : e);
        return false;
    }
}

/** Follow every hotfix still in flight (capped). Used by the hourly live-check run. */
export async function syncOpenHotfixes(db: Db, opts: { token?: string; repo?: string; fetchImpl?: FetchLike } = {}): Promise<number> {
    try {
        const rows = await db.execute(sql`
            SELECT id, dev_prod_status, dev_prod_at FROM issue_reports
             WHERE dev_prod_status IN ('hotfix_requested', 'hotfix_open')
             ORDER BY dev_prod_at ASC NULLS LAST LIMIT 10`) as Array<{ id: number; dev_prod_status: string; dev_prod_at: Date | string | null }>;
        let n = 0;
        for (const r of rows) {
            if (await syncHotfix(db, { id: Number(r.id), devProdStatus: r.dev_prod_status, devProdAt: r.dev_prod_at }, opts)) n++;
        }
        return n;
    } catch (e) {
        // Before db/z-issue-hotfix-pr.sql the statuses can't exist, so this simply finds nothing.
        console.error('[issue-hotfix] syncOpenHotfixes failed:', e instanceof Error ? e.message : e);
        return 0;
    }
}

