// src/utils/issue-fix-live.ts — Issues: tell the reporter only when the fix is LIVE, then auto-close.
//
// ── The problem this replaces ───────────────────────────────────────────────────────────────────
// maybeAdvanceToReadyToTest used to move an issue to "Fixed & Ready to Test", and email the
// reporter, the moment its fix PR merged to the STAGING branch. Customers use production, which only
// gets that fix when staging is next merged to main: they were asked to re-test something they could
// not see yet. And when nobody replied, the issue sat at "Ready to Test" for ever.
//
// ── What happens now ────────────────────────────────────────────────────────────────────────────
// 1. LIVE CHECK. For each merged fix not yet confirmed live, ask GitHub whether the PR's merge commit
//    is inside BUILD_COMMIT — the commit THIS deploy was built from (src/generated/build-commit.ts).
//    Prod runs it against the prod database and staging against staging's, so each reporter hears
//    when the fix reached the site they use. Only then: status 'fixed_ready_to_test', a thread note,
//    and one "fixed and live" notification.
// 2. AUTO-CLOSE. An issue still at 'fixed_ready_to_test' 7 days after fixed_at, with no reply from
//    the reporter since, is closed with a note and one last notification. A reply before then
//    already reopens it (issue-reports.ts → 'reported'), which takes it out of this query.
//
// ── Safety ──────────────────────────────────────────────────────────────────────────────────────
// • Nothing here trusts a caller: the deployed commit is baked in at build, and inclusion is
//   GitHub's answer. A run with no token, no baked commit or no SQL does nothing and says why.
// • Every status change is a compare-and-swap (WHERE status/live_pr_url still as read … RETURNING),
//   so two overlapping runs cannot notify twice (memory: x-refresh-double-run-2026-11-11).
// • Capped per run; GitHub failures leave the issue untouched for the next run.
// • Automatic incidents (user_id NULL) follow the same path; notifyIssueUser skips them.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { issueReportMessages } from '../../db/schema';
import { BUILD_COMMIT } from '../generated/build-commit';
import { notifyIssueUser } from './issue-reports';

type Db = ReturnType<typeof getDb>;

/** Days an issue waits at "Fixed & Ready to Test" for a reply before it closes itself. */
export const AUTO_CLOSE_DAYS = 7;
/** Most merged fixes checked against GitHub per run (two API calls each). */
export const MAX_LIVE_CHECKS_PER_RUN = 25;
/** Most issues auto-closed per run, so a backlog drains over a few runs instead of one email burst. */
export const MAX_AUTO_CLOSE_PER_RUN = 50;

const DEFAULT_REPO = 'mefenemer/Be-More-Swan';

let readyCache: { ready: boolean; at: number } | null = null;

/** Has db/z-issue-fix-live.sql reached this database? Cached; a "no" is re-checked every 5 minutes. */
export async function fixLiveColumnsReady(db: Db): Promise<boolean> {
    if (readyCache && (readyCache.ready || Date.now() - readyCache.at < 5 * 60_000)) return readyCache.ready;
    try {
        const rows = await db.execute(sql`
            SELECT 1 FROM information_schema.columns
             WHERE table_name = 'issue_reports' AND column_name = 'live_pr_url' LIMIT 1`) as unknown[];
        readyCache = { ready: rows.length > 0, at: Date.now() };
    } catch {
        readyCache = { ready: false, at: Date.now() };
    }
    return readyCache.ready;
}

/** Test seam: forget the cached column check. */
export function resetFixLiveColumnsCache(): void { readyCache = null; }

/**
 * Stamp fixed_at when an issue becomes 'fixed_ready_to_test' by any route other than the live check
 * (an admin setting it by hand), so the 7-day clock starts. No-op before the SQL. Never throws.
 */
export async function stampFixedAt(db: Db, issueId: number): Promise<void> {
    try {
        if (!(await fixLiveColumnsReady(db))) return;
        await db.execute(sql`UPDATE issue_reports SET fixed_at = now() WHERE id = ${issueId}`);
    } catch (e) {
        console.error('[issue-fix-live] stampFixedAt failed:', e instanceof Error ? e.message : e);
    }
}

/**
 * fixed_at / live_at for these issues, for the Fix pipeline board's "Waiting to go live" and
 * "closes in N days". Empty before the SQL. Never throws.
 */
export async function loadFixLiveFields(db: Db, ids: number[]): Promise<Map<number, { fixedAt: string | null; liveAt: string | null; livePrUrl: string | null }>> {
    const out = new Map<number, { fixedAt: string | null; liveAt: string | null; livePrUrl: string | null }>();
    const clean = ids.filter((id) => Number.isInteger(id));
    if (!clean.length) return out;
    try {
        if (!(await fixLiveColumnsReady(db))) return out;
        const rows = await db.execute(sql`
            SELECT id, fixed_at, live_at, live_pr_url FROM issue_reports
             WHERE id IN (${sql.join(clean.map((id) => sql`${id}`), sql`, `)})`) as Array<{ id: number; fixed_at: Date | string | null; live_at: Date | string | null; live_pr_url: string | null }>;
        const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());
        for (const r of rows) out.set(Number(r.id), { fixedAt: iso(r.fixed_at), liveAt: iso(r.live_at), livePrUrl: r.live_pr_url });
    } catch (e) {
        console.error('[issue-fix-live] loadFixLiveFields failed:', e instanceof Error ? e.message : e);
    }
    return out;
}

/** The PR number from a GitHub PR URL in THIS repo, or null (another repo, or not a PR URL). */
export function parsePrNumber(url: string | null | undefined, repo = DEFAULT_REPO): number | null {
    if (!url) return null;
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
    if (!m) return null;
    if (m[1].toLowerCase() !== repo.toLowerCase()) return null;
    const n = Number(m[2]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function isFullSha(s: string | null | undefined): s is string {
    return typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s);
}

export type FixDeployState = 'live' | 'not_yet' | 'not_merged' | 'error';

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/**
 * Is this PR's fix inside the deployed commit? GitHub's compare(base=merge commit, head=deployed)
 * says 'ahead' or 'identical' exactly when the deployed commit contains the merge commit; 'behind'
 * or 'diverged' means it does not (yet). Staging reaches main by merge commits, so ancestry holds.
 */
export async function checkFixDeployed(opts: {
    prNumber: number;
    deployedSha: string;
    token: string;
    repo?: string;
    fetchImpl?: FetchLike;
}): Promise<FixDeployState> {
    const repo = opts.repo || DEFAULT_REPO;
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    const headers = {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'issue-fix-live-check',
    };
    try {
        const pr = await f(`https://api.github.com/repos/${repo}/pulls/${opts.prNumber}`, { headers });
        if (!pr.ok) return 'error';
        const prBody = await pr.json();
        const mergeSha = prBody?.merged ? prBody?.merge_commit_sha : null;
        if (!isFullSha(mergeSha)) return 'not_merged';

        const cmp = await f(`https://api.github.com/repos/${repo}/compare/${mergeSha}...${opts.deployedSha}`, { headers });
        // 404 here is normal for a deploy commit GitHub hasn't indexed yet, or a merge commit from
        // a force-pushed branch — either way, not provably live.
        if (!cmp.ok) return cmp.status === 404 ? 'not_yet' : 'error';
        const status = (await cmp.json())?.status;
        if (status === 'ahead' || status === 'identical') return 'live';
        if (status === 'behind' || status === 'diverged') return 'not_yet';
        return 'error';
    } catch {
        return 'error';
    }
}

export interface FixLiveResult {
    skipped?: 'sql' | 'no_token' | 'no_commit';
    checked: number;
    live: number;
    notYet: number;
    errors: number;
    autoClosed: number;
}

/**
 * One pass: confirm merged fixes that are now live, then close issues nobody replied to.
 * The auto-close half runs even when the live check can't (no token / no baked commit), because
 * issues an admin set to "Fixed" by hand still need closing.
 */
export async function runFixLiveCheck(db: Db, opts: {
    deployedSha?: string;
    token?: string;
    repo?: string;
    fetchImpl?: FetchLike;
    now?: Date;
} = {}): Promise<FixLiveResult> {
    const result: FixLiveResult = { checked: 0, live: 0, notYet: 0, errors: 0, autoClosed: 0 };
    if (!(await fixLiveColumnsReady(db))) return { ...result, skipped: 'sql' };

    const deployedSha = opts.deployedSha ?? BUILD_COMMIT;
    const token = opts.token ?? process.env.GITHUB_FIX_CHECK_TOKEN ?? '';
    const repo = opts.repo || process.env.GITHUB_REPO || DEFAULT_REPO;

    if (!token) result.skipped = 'no_token';
    else if (!isFullSha(deployedSha)) result.skipped = 'no_commit';
    else await confirmLiveFixes(db, { deployedSha, token, repo, fetchImpl: opts.fetchImpl }, result);

    result.autoClosed = await autoCloseQuietFixes(db);
    return result;
}

async function confirmLiveFixes(
    db: Db,
    o: { deployedSha: string; token: string; repo: string; fetchImpl?: FetchLike },
    result: FixLiveResult,
): Promise<void> {
    // Merged fixes whose CURRENT PR hasn't been confirmed live. A reopened issue keeps live_pr_url
    // pointing at its old PR, so it only comes back here once a new fix PR replaces dev_pr_url.
    const rows = await db.execute(sql`
        SELECT id, user_id, dev_pr_url
          FROM issue_reports
         WHERE dev_merge_status = 'merged'
           AND dev_pr_url IS NOT NULL
           AND live_pr_url IS DISTINCT FROM dev_pr_url
           AND status NOT IN ('closed', 'roadmap')
           AND dev_sql_status IS DISTINCT FROM 'pending'
         ORDER BY dev_merged_at ASC NULLS LAST
         LIMIT ${MAX_LIVE_CHECKS_PER_RUN}`) as Array<{ id: number; user_id: number | null; dev_pr_url: string }>;

    for (const row of rows) {
        const prNumber = parsePrNumber(row.dev_pr_url, o.repo);
        if (!prNumber) { result.errors++; continue; }
        result.checked++;
        const state = await checkFixDeployed({ prNumber, deployedSha: o.deployedSha, token: o.token, repo: o.repo, fetchImpl: o.fetchImpl });
        if (state === 'not_yet' || state === 'not_merged') { result.notYet++; continue; }
        if (state === 'error') { result.errors++; continue; }

        // Compare-and-swap on the PR we checked: a second run, or a new fix landing meanwhile, misses.
        const claimed = await db.execute(sql`
            UPDATE issue_reports
               SET status = 'fixed_ready_to_test', fixed_at = now(), live_at = now(),
                   live_pr_url = ${row.dev_pr_url}, updated_at = now()
             WHERE id = ${row.id}
               AND dev_pr_url = ${row.dev_pr_url}
               AND live_pr_url IS DISTINCT FROM ${row.dev_pr_url}
               AND status NOT IN ('closed', 'roadmap')
            RETURNING id`) as unknown[];
        if (!claimed.length) continue;
        result.live++;

        await db.insert(issueReportMessages).values({
            issueId: row.id, authorType: 'admin', authorId: null,
            body: `✅ The fix is live now. Could you give it another try? If it's still not right, just reply here and we'll pick it straight back up. If we don't hear from you, this closes on its own in ${AUTO_CLOSE_DAYS} days.`,
            status: 'fixed_ready_to_test',
        });
        await notifyIssueUser(db, { userId: row.user_id, issueId: row.id, status: 'fixed_ready_to_test', variant: 'live' })
            .catch((e) => console.error('[issue-fix-live] live notify failed:', e?.message || e));
    }
}

async function autoCloseQuietFixes(db: Db): Promise<number> {
    // Start the clock on anything that reached "Ready to Test" without a stamp (set before the SQL,
    // or by a route that doesn't stamp): it gets the full 7 days from now, never an instant close.
    await db.execute(sql`
        UPDATE issue_reports SET fixed_at = now()
         WHERE status = 'fixed_ready_to_test' AND fixed_at IS NULL`);

    const closed = await db.execute(sql`
        UPDATE issue_reports i
           SET status = 'closed', resolved_at = now(), updated_at = now()
         WHERE i.id IN (
                SELECT r.id FROM issue_reports r
                 WHERE r.status = 'fixed_ready_to_test'
                   AND r.fixed_at < now() - make_interval(days => ${AUTO_CLOSE_DAYS})
                   AND NOT EXISTS (
                        SELECT 1 FROM issue_report_messages m
                         WHERE m.issue_id = r.id AND m.author_type = 'user' AND m.created_at > r.fixed_at)
                 ORDER BY r.fixed_at ASC
                 LIMIT ${MAX_AUTO_CLOSE_PER_RUN})
           AND i.status = 'fixed_ready_to_test'
        RETURNING i.id, i.user_id`) as Array<{ id: number; user_id: number | null }>;

    for (const row of closed) {
        await db.insert(issueReportMessages).values({
            issueId: row.id, authorType: 'admin', authorId: null,
            body: `We've closed this as we haven't heard back in ${AUTO_CLOSE_DAYS} days since the fix went out. If it's still not working, reply here and we'll reopen it.`,
            status: 'closed',
        });
        await notifyIssueUser(db, { userId: row.user_id, issueId: row.id, status: 'closed', variant: 'auto_closed' })
            .catch((e) => console.error('[issue-fix-live] auto-close notify failed:', e?.message || e));
    }
    return closed.length;
}
