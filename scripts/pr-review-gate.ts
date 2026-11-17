// scripts/pr-review-gate.ts — reads a PR from GitHub (`gh`) for the review gate: its tier from the diff, head
// commit, base and review verdicts (src/utils/pr-review.ts). Used by scripts/pr-tier.ts, fix-tickets.ts and
// feature-requests.ts. Import only: no main().

import { execFileSync } from 'node:child_process';
import { tierForChange, type ChangeTier } from '../src/config/review-tiers';
import { tierForDiff } from '../src/utils/pr-evidence';
import { parseReviews, reviewGate, type GateResult, type ReviewRecord } from '../src/utils/pr-review';

export const gh = (args: string[]) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** A PR's tier. `gh pr diff` refuses very large PRs: then file names only, and any SQL counts as high. */
export function prTier(pr: string): ChangeTier {
    try {
        return tierForDiff(gh(['pr', 'diff', pr]));
    } catch {
        const files = JSON.parse(gh(['pr', 'view', pr, '--json', 'files'])).files as Array<{ path: string }>;
        return tierForChange(files.map((f) => ({ path: f.path, sqlText: null })));
    }
}

export interface PrReviewState { pr: string; base: string; headSha: string; body: string; tier: ChangeTier; reviews: ReviewRecord[] }

export function loadPrReviewState(pr: string): PrReviewState {
    const v = JSON.parse(gh(['pr', 'view', pr, '--json', 'baseRefName,headRefOid,body,comments'])) as {
        baseRefName: string; headRefOid: string; body: string; comments: Array<{ body: string; createdAt: string; url: string; authorAssociation: string }>;
    };
    return { pr, base: v.baseRefName, headSha: v.headRefOid, body: v.body || '', tier: prTier(pr), reviews: parseReviews(v.comments || []) };
}

export function prGate(pr: string, override?: string | null): GateResult & { state: PrReviewState } {
    const state = loadPrReviewState(pr);
    return { ...reviewGate({ tier: state.tier.tier, base: state.base, headSha: state.headSha, reviews: state.reviews, override }), state };
}
