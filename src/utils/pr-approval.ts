// src/utils/pr-approval.ts — staging / prod PR pills and the owner's "Approve" button on the Fix pipeline and
// the Feature requests board (owner, 2026-11-13).
//
//   • Pills: the staging PR (dev_pr_url) and the prod PR (prod_pr_url; for a fix, also a hotfix PR recorded in
//     dev_prod_result) show on the board card and the open ticket as soon as they are recorded, each a link to
//     the PR on GitHub.
//   • Approve: Claude asks from its session (scripts/fix-tickets.ts / scripts/feature-requests.ts
//     ask-approval), which sets approval_pr_url. While that is set the ticket shows "Approve PR #N". The click
//     (approveTicketPr) approves the PR on GitHub where GitHub allows it, merges it (or turns on auto-merge when
//     its checks are still running), moves the ticket on, and clears the request, so the button goes.
//
// ⚠️ GitHub never lets an account approve its OWN pull request, and Claude opens PRs as the owner's account,
// so the review step usually can't happen. main needs 0 approving reviews, so the merge is the real gate:
// the button always merges. The review is attempted anyway (it works for a PR someone else opened).
//
// Nothing here contacts a reporter, submitter or voter: issue notes are author_id NULL (internal) and a
// feature request moved to Released by this click sends no broadcast; the owner does all communication.
//
// Columns from db/z-pr-approval.sql, read raw behind prApprovalColumnsReady() (not in db/schema.ts).
// GitHub token: GITHUB_PR_APPROVE_TOKEN (fine-grained, this repo: Contents read/write + Pull requests
// read/write), falling back to GITHUB_HOTFIX_TOKEN.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { parsePrNumber } from './issue-fix-live';
import { loadProofRow } from './issue-fix-proof';
import { sqlHash } from './issue-sql';

type Db = ReturnType<typeof getDb>;
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
export type PrTicketKind = 'issue' | 'feature';

const DEFAULT_REPO = 'mefenemer/Be-More-Swan';
const repoOf = (r?: string) => r || process.env.GITHUB_REPO || DEFAULT_REPO;
export const approveToken = () => process.env.GITHUB_PR_APPROVE_TOKEN || process.env.GITHUB_HOTFIX_TOKEN || '';
const TABLE: Record<PrTicketKind, string> = { issue: 'issue_reports', feature: 'feature_requests' };

let readyCache: { ready: boolean; at: number } | null = null;
export async function prApprovalColumnsReady(db: Db): Promise<boolean> {
    if (readyCache && (readyCache.ready || Date.now() - readyCache.at < 5 * 60_000)) return readyCache.ready;
    try {
        const rows = await db.execute(sql`
            SELECT count(*)::int AS n FROM information_schema.columns
             WHERE table_name IN ('issue_reports', 'feature_requests') AND column_name = 'approval_pr_url'`) as Array<{ n: number }>;
        readyCache = { ready: Number(rows[0]?.n) === 2, at: Date.now() };
    } catch {
        readyCache = { ready: false, at: Date.now() };
    }
    return readyCache.ready;
}
export function resetPrApprovalCache(): void { readyCache = null; }

export interface PrFields { prodPrUrl: string | null; approvalPrUrl: string | null; approvalNote: string | null; approvalRequestedAt: string | null }
export const NO_PR_FIELDS: PrFields = { prodPrUrl: null, approvalPrUrl: null, approvalNote: null, approvalRequestedAt: null };

/** A hotfix PR recorded by issue-hotfix.ts in dev_prod_result ("Hotfix PR: <url>"). */
export function hotfixUrlFromResult(result: string | null | undefined): string | null {
    const m = /Hotfix PR: (https:\/\/github\.com\/\S+\/pull\/\d+)/.exec(result || '');
    return m ? m[1] : null;
}

/** Prod PR + approval request for each ticket, by id. Before the SQL: a fix's hotfix PR only. */
export async function loadPrFields(db: Db, kind: PrTicketKind, ids: number[]): Promise<Map<number, PrFields>> {
    const out = new Map<number, PrFields>();
    const list = ids.map(Number).filter(Number.isFinite);
    if (!list.length) return out;
    const idSql = sql.raw(`(${list.join(',')})`);
    try {
        if (!(await prApprovalColumnsReady(db))) {
            if (kind !== 'issue') return out;
            const rows = await db.execute(sql`
                SELECT id, dev_prod_result FROM issue_reports WHERE id IN ${idSql} AND dev_prod_result LIKE '%Hotfix PR: %'`) as Array<{ id: number; dev_prod_result: string | null }>;
            for (const r of rows) out.set(Number(r.id), { ...NO_PR_FIELDS, prodPrUrl: hotfixUrlFromResult(r.dev_prod_result) });
            return out;
        }
        const rows = (kind === 'issue'
            ? await db.execute(sql`
                SELECT id, prod_pr_url, dev_prod_result, approval_pr_url, approval_note, approval_requested_at::text AS approval_requested_at
                  FROM issue_reports WHERE id IN ${idSql}
                   AND (prod_pr_url IS NOT NULL OR approval_pr_url IS NOT NULL OR dev_prod_result LIKE '%Hotfix PR: %')`)
            : await db.execute(sql`
                SELECT id, prod_pr_url, NULL::text AS dev_prod_result, approval_pr_url, approval_note, approval_requested_at::text AS approval_requested_at
                  FROM feature_requests WHERE id IN ${idSql}
                   AND (prod_pr_url IS NOT NULL OR approval_pr_url IS NOT NULL)`)) as Array<{
            id: number; prod_pr_url: string | null; dev_prod_result: string | null; approval_pr_url: string | null; approval_note: string | null; approval_requested_at: string | null;
        }>;
        for (const r of rows) {
            out.set(Number(r.id), {
                prodPrUrl: r.prod_pr_url || hotfixUrlFromResult(r.dev_prod_result),
                approvalPrUrl: r.approval_pr_url,
                approvalNote: r.approval_note,
                approvalRequestedAt: r.approval_requested_at,
            });
        }
    } catch (e) {
        console.error('[pr-approval] loadPrFields failed:', e instanceof Error ? e.message : e);
    }
    return out;
}

// ── GitHub ───────────────────────────────────────────────────────────────────────

function ghHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pr-approval', 'Content-Type': 'application/json' };
}

export interface GhPr { number: number; url: string; state: 'open' | 'closed'; merged: boolean; base: string; nodeId: string; title: string }

export type ApproveOutcome =
    | { ok: true; pr: GhPr; merged: boolean; autoMerge: boolean; reviewed: boolean }
    | { ok: false; error: string; status: number };

/**
 * Approve (where GitHub allows) and merge one PR. A PR whose checks are still running gets auto-merge
 * instead, so it merges itself when they pass. Already merged = success.
 */
export async function approveAndMergePr(opts: { prNumber: number; token: string; repo?: string; fetchImpl?: FetchLike }): Promise<ApproveOutcome> {
    const repo = repoOf(opts.repo);
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    const h = ghHeaders(opts.token);
    const base = `https://api.github.com/repos/${repo}/pulls/${opts.prNumber}`;
    try {
        const res = await f(base, { headers: h });
        if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, status: 502, error: `GitHub refused to show PR #${opts.prNumber} (HTTP ${res.status}): check GITHUB_PR_APPROVE_TOKEN in Netlify.` };
        if (!res.ok) return { ok: false, status: 502, error: `GitHub could not load PR #${opts.prNumber} (HTTP ${res.status}).` };
        const p = await res.json();
        const pr: GhPr = { number: Number(p.number), url: String(p.html_url), state: p.state === 'open' ? 'open' : 'closed', merged: !!p.merged_at, base: String(p.base?.ref || ''), nodeId: String(p.node_id || ''), title: String(p.title || '') };
        if (pr.merged) return { ok: true, pr, merged: true, autoMerge: false, reviewed: false };
        if (pr.state === 'closed') return { ok: false, status: 409, error: `PR #${pr.number} was closed without merging. Ask Claude for a new one.` };

        // The review: refused (422) for the token owner's own PR, which is normal here; never blocks the merge.
        const review = await f(`${base}/reviews`, { method: 'POST', headers: h, body: JSON.stringify({ event: 'APPROVE', body: 'Approved in the Be More Swan admin.' }) });
        const reviewed = review.ok;

        const merge = await f(`${base}/merge`, { method: 'PUT', headers: h, body: JSON.stringify({ merge_method: 'merge' }) });
        if (merge.ok) return { ok: true, pr, merged: true, autoMerge: false, reviewed };
        if (merge.status === 401 || merge.status === 403) return { ok: false, status: 502, error: 'GitHub refused to merge with this token: GITHUB_PR_APPROVE_TOKEN needs Contents and Pull requests read/write on this repo.' };
        if (merge.status === 409) return { ok: false, status: 409, error: `PR #${pr.number} has a merge conflict or its branch moved. Ask Claude to update it.` };

        // 405 = not mergeable yet (checks running, or the branch is behind): let GitHub merge it when ready.
        const gql = await f('https://api.github.com/graphql', {
            method: 'POST', headers: h,
            body: JSON.stringify({ query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) { pullRequest { number } } }', variables: { id: pr.nodeId } }),
        });
        const g = gql.ok ? await gql.json() : null;
        if (g && !g.errors) return { ok: true, pr, merged: false, autoMerge: true, reviewed };
        let why = '';
        try { why = String((await merge.json())?.message || ''); } catch { /* none */ }
        const gErr = g?.errors?.[0]?.message ? ` Auto-merge: ${g.errors[0].message}` : '';
        return { ok: false, status: 409, error: `GitHub would not merge PR #${pr.number} yet${why ? ` (${why})` : ''}.${gErr}` };
    } catch (e) {
        return { ok: false, status: 502, error: `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}` };
    }
}

// ── The owner's click ────────────────────────────────────────────────────────────

/** What a fix needs before its PR may merge into this base. null = fine. */
export async function issueMergeBlocker(db: Db, issueId: number, base: string): Promise<string | null> {
    const row = await loadProofRow(db, issueId);
    const text = (row?.devSql || '').trim();
    if (!row || !text) return null;
    if (base === 'staging' && !(row.devStagingSqlStatus === 'applied' && row.devStagingSqlHash === sqlHash(text))) {
        return 'This fix\'s SQL is not on the staging database yet. Ask Claude to run it on staging first.';
    }
    if (base === 'main' && row.devProdSqlStatus !== 'applied') {
        return 'This fix\'s SQL is not on the production database yet. Use Approve for production (it runs the SQL first), or ask Claude to run the prod SQL.';
    }
    return null;
}

export async function approveTicketPr(db: Db, kind: PrTicketKind, id: number, opts: {
    token?: string; repo?: string; fetchImpl?: FetchLike; adminName?: string;
} = {}): Promise<{ ok: true; message: string; base: string; merged: boolean; autoMerge: boolean } | { ok: false; error: string; status: number }> {
    if (!(await prApprovalColumnsReady(db))) return { ok: false, status: 400, error: 'Run db/z-pr-approval.sql on this database first.' };
    const table = sql.raw(TABLE[kind]);
    const [row] = await db.execute(sql`SELECT approval_pr_url, approval_note FROM ${table} WHERE id = ${id}`) as Array<{ approval_pr_url: string | null; approval_note: string | null }>;
    if (!row) return { ok: false, status: 404, error: 'Not found.' };
    const url = row.approval_pr_url;
    if (!url) return { ok: false, status: 409, error: 'Nothing is waiting for your approval on this ticket.' };
    const prNumber = parsePrNumber(url, repoOf(opts.repo));
    if (!prNumber) return { ok: false, status: 400, error: `${url} is not a pull request in ${repoOf(opts.repo)}.` };
    const token = opts.token ?? approveToken();
    if (!token) return { ok: false, status: 500, error: 'GITHUB_PR_APPROVE_TOKEN is not set in Netlify, so the PR cannot be merged from here.' };

    // Claim: clearing the request hides the button and stops a double click merging twice.
    const claimed = await db.execute(sql`UPDATE ${table} SET approval_pr_url = NULL WHERE id = ${id} AND approval_pr_url = ${url} RETURNING id`) as unknown[];
    if (!claimed.length) return { ok: false, status: 409, error: 'This PR is already being approved.' };
    const restore = () => db.execute(sql`UPDATE ${table} SET approval_pr_url = ${url} WHERE id = ${id} AND approval_pr_url IS NULL`);

    // A fix's SQL goes first. The PR's base decides which database, so look it up before merging.
    if (kind === 'issue') {
        const f = opts.fetchImpl || (fetch as unknown as FetchLike);
        let base = '';
        try {
            const r = await f(`https://api.github.com/repos/${repoOf(opts.repo)}/pulls/${prNumber}`, { headers: ghHeaders(token) });
            if (r.ok) base = String((await r.json())?.base?.ref || '');
        } catch { /* approveAndMergePr reports GitHub trouble */ }
        const blocker = base ? await issueMergeBlocker(db, id, base) : null;
        if (blocker) { await restore(); return { ok: false, status: 409, error: blocker }; }
    }

    const res = await approveAndMergePr({ prNumber, token, repo: opts.repo, fetchImpl: opts.fetchImpl });
    if (!res.ok) { await restore(); return res; }

    const { pr, merged, autoMerge } = res;
    const how = merged ? 'merged' : 'set to merge itself once its checks pass';
    const who = opts.adminName ? ` by ${opts.adminName}` : '';
    let message: string;
    if (kind === 'issue') {
        if (pr.base === 'main') {
            await db.execute(sql`
                UPDATE issue_reports SET prod_pr_url = ${pr.url}, dev_prod_status = 'promoted', dev_prod_at = now(),
                       dev_prod_result = ${`Prod PR: ${pr.url}\nApproved${who} and ${how} into main. The reporter is told once the prod deploy contains it.`},
                       approval_note = NULL, approval_requested_at = NULL, updated_at = now()
                 WHERE id = ${id}`);
            message = `✅ Prod PR #${pr.number} approved${who} and ${how} into main. The ticket moves to Fixed & Ready to Test once the prod deploy contains it.`;
        } else if (pr.base === 'staging') {
            await db.execute(sql`
                UPDATE issue_reports SET dev_pr_url = coalesce(dev_pr_url, ${pr.url}), dev_merge_status = 'merged', dev_merged_at = now(),
                       dev_merge_result = ${`Approved${who} and ${how} into staging.`},
                       dev_runner_id = CASE WHEN dev_runner_id = 'Claude (interactive)' THEN NULL ELSE dev_runner_id END,
                       dev_runner_heartbeat = CASE WHEN dev_runner_id = 'Claude (interactive)' THEN NULL ELSE dev_runner_heartbeat END,
                       approval_note = NULL, approval_requested_at = NULL, updated_at = now()
                 WHERE id = ${id}`);
            message = `✅ Staging PR #${pr.number} approved${who} and ${how} into staging. The "Ready for production?" checklist now follows staging's tests and deploy.`;
        } else {
            await db.execute(sql`UPDATE issue_reports SET approval_note = NULL, approval_requested_at = NULL, updated_at = now() WHERE id = ${id}`);
            message = `✅ PR #${pr.number} approved${who} and ${how} into ${pr.base}.`;
        }
        await db.execute(sql`
            INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
            VALUES (${id}, 'admin', NULL, ${`${message}\n${pr.url}`}, NULL)`);
    } else {
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        if (pr.base === 'main') {
            await db.execute(sql`
                UPDATE feature_requests SET prod_pr_url = ${pr.url}, status = 'released', released_at = coalesce(released_at, now()),
                       dev_runner_id = NULL, dev_runner_heartbeat = NULL, approval_note = NULL, approval_requested_at = NULL, updated_at = now()
                 WHERE id = ${id}`);
            message = `✅ Prod PR #${pr.number} approved${who} and ${how} into main. Moved to Released (no one was notified).`;
        } else {
            await db.execute(sql`
                UPDATE feature_requests SET dev_pr_url = coalesce(dev_pr_url, ${pr.url}),
                       status = CASE WHEN status IN ('open', 'planned', 'brief_ready') THEN 'in_progress' ELSE status END,
                       approval_note = NULL, approval_requested_at = NULL, updated_at = now()
                 WHERE id = ${id}`);
            message = `✅ ${pr.base === 'staging' ? 'Staging PR' : 'PR'} #${pr.number} approved${who} and ${how} into ${pr.base}.`;
        }
        await db.execute(sql`
            UPDATE feature_requests SET dev_notes = concat_ws(E'\n\n', dev_notes, ${`[${stamp} UTC] ${message}\n${pr.url}`}::text) WHERE id = ${id}`);
    }
    return { ok: true, message, base: pr.base, merged, autoMerge };
}
