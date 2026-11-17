// src/utils/pr-review-remote.ts — the review gate from inside the app (no `gh`): reads a PR, its files and its
// review comments through the GitHub REST API (docs/review-tiers-plan.md, Phase 3).
//
//   • cloudMergeReviewBlocker(): the admin "Merge to staging" / "Merge all" buttons (admin-issue-reports.ts)
//     run the same gate as ask-approval, so they can't merge a medium/high fix with no review.
//   • loadRemotePr(): used by the merge sweep (src/utils/pr-approvals.ts) to record each merged PR's tier and
//     verdict.
// Fails CLOSED: if GitHub can't be read, the merge button says why instead of merging unchecked.

import { tierForChange, type ChangeTier } from '../config/review-tiers';
import { parseReviews, reviewGate, type GateResult, type ReviewRecord } from './pr-review';
import { ghHeaders, readToken, repoOf } from './issue-github';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface RemotePr {
    number: number; title: string; url: string; base: string; headSha: string;
    mergedAt: string | null; mergeSha: string | null; tier: ChangeTier; reviews: ReviewRecord[];
}

const MAX_PAGES = 3; // 300 files / 300 comments: beyond that, file names still count (see below)

/** Lines a GitHub file patch adds. No patch (binary, or too big for GitHub to show) = unknown. */
export function addedLinesFromPatch(patch: string | null | undefined): string | null {
    if (patch == null) return null;
    return patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
}

async function pages(f: FetchLike, url: string, token: string): Promise<any[] | number> {
    const out: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await f(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { headers: ghHeaders(token) });
        if (!r.ok) return r.status;
        const batch = await r.json();
        if (!Array.isArray(batch)) return 502;
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
}

export async function loadRemotePr(prNumber: number, opts: { token: string; repo?: string; fetchImpl?: FetchLike }): Promise<RemotePr | { error: string }> {
    const f = opts.fetchImpl || (fetch as unknown as FetchLike);
    const base = `https://api.github.com/repos/${repoOf(opts.repo)}`;
    try {
        const r = await f(`${base}/pulls/${prNumber}`, { headers: ghHeaders(opts.token) });
        if (!r.ok) return { error: `GitHub could not show PR #${prNumber} (HTTP ${r.status}).` };
        const p = await r.json();
        const files = await pages(f, `${base}/pulls/${prNumber}/files`, opts.token);
        if (typeof files === 'number') return { error: `GitHub could not list PR #${prNumber}'s files (HTTP ${files}).` };
        const comments = await pages(f, `${base}/issues/${prNumber}/comments`, opts.token);
        if (typeof comments === 'number') return { error: `GitHub could not list PR #${prNumber}'s comments (HTTP ${comments}).` };
        const changed: Array<{ path: string; sqlText: string | null }> = [];
        for (const x of files) {
            const added = addedLinesFromPatch(x.patch);
            changed.push({ path: String(x.filename), sqlText: added });
            if (x.previous_filename) changed.push({ path: String(x.previous_filename), sqlText: added });
        }
        const tier = tierForChange(changed);
        // More files than we read: whatever we didn't see could be high.
        if (files.length >= MAX_PAGES * 100 && tier.tier !== 'high') {
            const t2 = tierForChange([...changed, { path: '(more files)', sqlText: null, forceHigh: `more than ${MAX_PAGES * 100} files` }]);
            Object.assign(tier, t2);
        }
        return {
            number: Number(p.number), title: String(p.title || ''), url: String(p.html_url || ''),
            base: String(p.base?.ref || ''), headSha: String(p.head?.sha || ''),
            mergedAt: p.merged_at ? String(p.merged_at) : null, mergeSha: p.merge_commit_sha && p.merged_at ? String(p.merge_commit_sha) : null,
            tier,
            reviews: parseReviews(comments.map((c: any) => ({ body: c.body, createdAt: c.created_at, url: c.html_url, authorAssociation: c.author_association }))),
        };
    } catch (e) {
        return { error: `GitHub could not be reached for PR #${prNumber}: ${e instanceof Error ? e.message : String(e)}` };
    }
}

export async function remoteReviewGate(prNumber: number, opts: { token?: string; repo?: string; fetchImpl?: FetchLike } = {}): Promise<(GateResult & { pr: RemotePr }) | { error: string }> {
    const token = opts.token ?? readToken();
    if (!token) return { error: 'The second-opinion review could not be checked: no GitHub token is set in Netlify (GITHUB_AI_FIX_TOKEN, GITHUB_HOTFIX_TOKEN or GITHUB_FIX_CHECK_TOKEN).' };
    const pr = await loadRemotePr(prNumber, { token, repo: opts.repo, fetchImpl: opts.fetchImpl });
    if ('error' in pr) return { error: `The second-opinion review could not be checked. ${pr.error}` };
    return { ...reviewGate({ tier: pr.tier.tier, base: pr.base, headSha: pr.headSha, reviews: pr.reviews }), pr };
}

/** The Merge to staging check: `blocked` = why it may not merge (shown on the ticket), else null and `headSha` =
 *  the commit that passed, which the workflow then merges and nothing else (`--match-head-commit`). */
export async function cloudMergeCheck(prNumber: number, opts: { token?: string; repo?: string; fetchImpl?: FetchLike } = {}): Promise<{ blocked: string | null; headSha: string | null }> {
    const g = await remoteReviewGate(prNumber, opts);
    if ('error' in g) return { blocked: g.error, headSha: null };
    return g.ok ? { blocked: null, headSha: g.pinSha } : { blocked: `Not merged: ${g.reason}`, headSha: null };
}

/** null = the Merge to staging button may go ahead. Otherwise the reason it may not. */
export async function cloudMergeReviewBlocker(prNumber: number, opts: { token?: string; repo?: string; fetchImpl?: FetchLike } = {}): Promise<string | null> {
    return (await cloudMergeCheck(prNumber, opts)).blocked;
}
