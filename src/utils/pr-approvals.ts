// src/utils/pr-approvals.ts — the approval record (docs/review-tiers-plan.md, Phase 3; owner 2026-11-17).
//
//   • recordButtonApproval(): the admin Approve click (pr-approval.ts) notes who approved which commit.
//   • sweepMergedPrs(): on the live-check tick (check-fixes-live.ts), every PR merged into staging or main gets
//     a row with its tier and the second-opinion verdict for the commit that merged — including PRs merged
//     OUTSIDE the button (`gh pr merge` on the owner's word, "Merge to staging"), so nothing is missing.
//   • listApprovals(): Admin → Systems → Approvals. approvalFlag() marks a medium/high PR into staging merged
//     after reviews began with no passing verdict for the commit that merged.
//
// Table from db/z-pr-approvals.sql, read raw behind prApprovalsReady() (not in db/schema.ts). Never throws
// into the tick: GitHub or DB trouble is logged and the sweep stops.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { tierSummary, type ReviewTier } from '../config/review-tiers';
import { readToken, repoOf, ghHeaders } from './issue-github';
import { loadRemotePr, type FetchLike, type RemotePr } from './pr-review-remote';
import type { ReviewVerdict } from './pr-review';

type Db = ReturnType<typeof getDb>;

/** Merges before this didn't have second-opinion reviews (Phase 2 merged 2026-11-17), so they aren't flagged. */
export const REVIEWS_BEGAN_AT = '2026-11-17T12:00:00Z';
const SWEEP_BASES = ['staging', 'main'] as const;
const SWEEP_LOOKBACK = 30; // most recently updated closed PRs per base, each tick
const SWEEP_MAX_LOADS = 10; // full PR loads (files + comments) per tick

let readyCache: { ready: boolean; at: number } | null = null;
export async function prApprovalsReady(db: Db): Promise<boolean> {
    if (readyCache && (readyCache.ready || Date.now() - readyCache.at < 5 * 60_000)) return readyCache.ready;
    try {
        const rows = await db.execute(sql`SELECT to_regclass('public.pr_approvals') IS NOT NULL AS ok`) as Array<{ ok: boolean }>;
        readyCache = { ready: !!rows[0]?.ok, at: Date.now() };
    } catch {
        readyCache = { ready: false, at: Date.now() };
    }
    return readyCache.ready;
}
export function resetPrApprovalsCache(): void { readyCache = null; }

export interface ApprovalRow {
    prNumber: number; base: string | null; title: string | null; url: string | null;
    tier: ReviewTier | null; tierReason: string | null; headSha: string | null;
    reviewerVerdict: ReviewVerdict | null; reviewerSha: string | null; reviewUrl: string | null;
    approvedVia: 'button' | 'other'; approvedBy: string | null; approvedSha: string | null;
    mergedAt: string | null; mergedSha: string | null;
}

/** The row a merged PR gets from GitHub. The verdict shown is the latest one for the head commit, else the latest
 *  at all (its sha then differs from head, which the flag reads as "stale"). */
export function approvalFromRemote(pr: RemotePr): Omit<ApprovalRow, 'approvedVia' | 'approvedBy' | 'approvedSha'> {
    const forHead = [...pr.reviews].reverse().find((r) => r.sha === pr.headSha) || null;
    const shown = forHead || (pr.reviews.length ? pr.reviews[pr.reviews.length - 1] : null);
    return {
        prNumber: pr.number, base: pr.base, title: pr.title, url: pr.url,
        tier: pr.tier.tier, tierReason: tierSummary(pr.tier), headSha: pr.headSha,
        reviewerVerdict: shown?.verdict || null, reviewerSha: shown?.sha || null, reviewUrl: shown?.url || null,
        mergedAt: pr.mergedAt, mergedSha: pr.mergeSha,
    };
}

export type ApprovalFlag = 'ok' | 'no-review' | 'stale-review' | 'changes-needed' | 'before-reviews' | 'not-needed';

/** Should the owner look at this merge? Only medium/high PRs into staging need a review; main gets its
 *  reviews through the staging PRs. */
export function approvalFlag(r: Pick<ApprovalRow, 'base' | 'tier' | 'headSha' | 'reviewerVerdict' | 'reviewerSha' | 'mergedAt'>): ApprovalFlag {
    if (r.base !== 'staging' || r.tier === 'low') return 'not-needed';
    if (r.mergedAt && r.mergedAt < REVIEWS_BEGAN_AT) return 'before-reviews';
    if (!r.reviewerVerdict) return 'no-review';
    if (r.reviewerSha !== r.headSha) return 'stale-review';
    if (r.reviewerVerdict === 'changes') return 'changes-needed';
    return 'ok';
}

/** The Approve click: who approved which commit. Tier/verdict/merge fields come from the sweep. */
export async function recordButtonApproval(db: Db, o: { prNumber: number; base: string; url: string; title: string; approvedBy: string | null; approvedSha: string | null; merged: boolean; repo?: string }): Promise<void> {
    try {
        if (!(await prApprovalsReady(db))) return;
        await db.execute(sql`
            INSERT INTO pr_approvals (repo, pr_number, base, url, title, approved_via, approved_by, approved_sha, merged_at)
            VALUES (${repoOf(o.repo)}, ${o.prNumber}, ${o.base}, ${o.url}, ${o.title}, 'button', ${o.approvedBy}, ${o.approvedSha}, ${o.merged ? sql`now()` : null})
            ON CONFLICT (repo, pr_number) DO UPDATE SET
                approved_via = 'button', approved_by = EXCLUDED.approved_by, approved_sha = EXCLUDED.approved_sha,
                base = EXCLUDED.base, url = EXCLUDED.url, title = EXCLUDED.title,
                merged_at = coalesce(pr_approvals.merged_at, EXCLUDED.merged_at), updated_at = now()`);
    } catch (e) {
        console.error('[pr-approvals] button record failed', e);
    }
}

/** Upsert from GitHub. Keeps how it was approved (the button's row) — only fills what GitHub knows. */
export async function upsertFromRemote(db: Db, a: ReturnType<typeof approvalFromRemote>, repo?: string): Promise<void> {
    await db.execute(sql`
        INSERT INTO pr_approvals (repo, pr_number, base, title, url, tier, tier_reason, head_sha, reviewer_verdict, reviewer_sha, review_url, merged_at, merged_sha)
        VALUES (${repoOf(repo)}, ${a.prNumber}, ${a.base}, ${a.title}, ${a.url}, ${a.tier}, ${a.tierReason}, ${a.headSha}, ${a.reviewerVerdict}, ${a.reviewerSha}, ${a.reviewUrl}, ${a.mergedAt}::timestamptz, ${a.mergedSha})
        ON CONFLICT (repo, pr_number) DO UPDATE SET
            base = EXCLUDED.base, title = EXCLUDED.title, url = EXCLUDED.url, tier = EXCLUDED.tier, tier_reason = EXCLUDED.tier_reason,
            head_sha = EXCLUDED.head_sha, reviewer_verdict = EXCLUDED.reviewer_verdict, reviewer_sha = EXCLUDED.reviewer_sha,
            review_url = EXCLUDED.review_url, merged_at = EXCLUDED.merged_at, merged_sha = EXCLUDED.merged_sha, updated_at = now()`);
}

export interface SweepResult { recorded: number; skipped?: string }

/** Record every recently merged PR into staging/main that has no complete row yet. */
export async function sweepMergedPrs(db: Db, opts: { token?: string; repo?: string; fetchImpl?: FetchLike } = {}): Promise<SweepResult> {
    try {
        if (!(await prApprovalsReady(db))) return { recorded: 0, skipped: 'db/z-pr-approvals.sql not run on this database' };
        const token = opts.token ?? readToken();
        if (!token) return { recorded: 0, skipped: 'no GitHub token' };
        const f = opts.fetchImpl || (fetch as unknown as FetchLike);
        const repo = repoOf(opts.repo);
        const merged: number[] = [];
        for (const base of SWEEP_BASES) {
            const r = await f(`https://api.github.com/repos/${repo}/pulls?state=closed&base=${base}&sort=updated&direction=desc&per_page=${SWEEP_LOOKBACK}`, { headers: ghHeaders(token) });
            if (!r.ok) return { recorded: 0, skipped: `GitHub refused the PR list (HTTP ${r.status})` };
            for (const p of await r.json()) if (p?.merged_at) merged.push(Number(p.number));
        }
        if (!merged.length) return { recorded: 0 };
        const done = await db.execute(sql`
            SELECT pr_number FROM pr_approvals
             WHERE repo = ${repo} AND pr_number IN ${sql.raw(`(${merged.join(',')})`)} AND merged_at IS NOT NULL AND tier IS NOT NULL`) as Array<{ pr_number: number }>;
        const have = new Set(done.map((d) => Number(d.pr_number)));
        let recorded = 0;
        for (const n of merged.filter((x) => !have.has(x)).slice(0, SWEEP_MAX_LOADS)) {
            const pr = await loadRemotePr(n, { token, repo, fetchImpl: f });
            if ('error' in pr) { console.warn(`[pr-approvals] ${pr.error}`); continue; }
            if (!pr.mergedAt) continue;
            await upsertFromRemote(db, approvalFromRemote(pr), repo);
            recorded++;
        }
        return { recorded };
    } catch (e) {
        console.error('[pr-approvals] sweep failed', e);
        return { recorded: 0, skipped: e instanceof Error ? e.message : String(e) };
    }
}

export interface ApprovalListItem extends ApprovalRow { flag: ApprovalFlag }

export async function listApprovals(db: Db, limit = 30): Promise<{ ready: boolean; items: ApprovalListItem[] }> {
    if (!(await prApprovalsReady(db))) return { ready: false, items: [] };
    const rows = await db.execute(sql`
        SELECT pr_number, base, title, url, tier, tier_reason, head_sha, reviewer_verdict, reviewer_sha, review_url,
               approved_via, approved_by, approved_sha, merged_at::text AS merged_at, merged_sha
          FROM pr_approvals WHERE merged_at IS NOT NULL
         ORDER BY merged_at DESC LIMIT ${Math.max(1, Math.min(100, limit))}`) as Array<Record<string, any>>;
    const items = rows.map((r) => {
        const row: ApprovalRow = {
            prNumber: Number(r.pr_number), base: r.base, title: r.title, url: r.url, tier: r.tier, tierReason: r.tier_reason,
            headSha: r.head_sha, reviewerVerdict: r.reviewer_verdict, reviewerSha: r.reviewer_sha, reviewUrl: r.review_url,
            approvedVia: r.approved_via === 'button' ? 'button' : 'other', approvedBy: r.approved_by, approvedSha: r.approved_sha,
            mergedAt: r.merged_at ? new Date(r.merged_at).toISOString() : null, mergedSha: r.merged_sha,
        };
        return { ...row, flag: approvalFlag(row) };
    });
    return { ready: true, items };
}
