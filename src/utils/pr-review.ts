// src/utils/pr-review.ts — the second-opinion review verdict on a PR, and the gate it opens (owner, 2026-11-17;
// docs/review-tiers-plan.md §2, Phase 2).
//
//   • The reviewer agent (.claude/agents/code-reviewer.md, Opus 5.5, fresh context) posts its verdict as a PR
//     comment with a hidden marker, via `scripts/pr-tier.ts record-review`. The marker names the commit it read.
//   • ask-approval (scripts/fix-tickets.ts, scripts/feature-requests.ts) and `pr-tier.ts check` call
//     reviewGate(): a medium/high PR into staging needs a verdict for its CURRENT head commit, and "Changes
//     needed" blocks unless Claude gives an override reason (shown to the owner). Low tier needs none. PRs into
//     main (releases, hotfixes) are reviewed as their staging PRs, so they pass with a note.
//   • The approval note carries "reviewed commit <sha>": the Approve click (pr-approval.ts) makes GitHub refuse
//     the merge if the PR changed after the review.

import type { ReviewTier } from '../config/review-tiers';

export type ReviewVerdict = 'pass' | 'notes' | 'changes';
export const VERDICT_LABEL: Record<ReviewVerdict, string> = { pass: 'Pass', notes: 'Pass with notes', changes: 'Changes needed' };
const VERDICT_ICON: Record<ReviewVerdict, string> = { pass: '✅', notes: '📝', changes: '⛔' };
const TIER_ICON: Record<ReviewTier, string> = { high: '🔴', medium: '🟠', low: '🟢' };

export const REVIEW_MODEL = 'Opus 5.5';
const MARKER_RE = /<!--\s*swan-review v1 sha=([0-9a-f]{40}) verdict=(pass|notes|changes) tier=(low|medium|high)\s*-->/;

export function isVerdict(v: unknown): v is ReviewVerdict { return v === 'pass' || v === 'notes' || v === 'changes'; }

/** The PR comment the reviewer posts. The first line is the marker the gate reads. */
export function formatReviewComment(o: { sha: string; verdict: ReviewVerdict; tier: ReviewTier; findings: string }): string {
    if (!/^[0-9a-f]{40}$/.test(o.sha)) throw new Error('A review must name the full 40-character commit it read.');
    return [
        `<!-- swan-review v1 sha=${o.sha} verdict=${o.verdict} tier=${o.tier} -->`,
        `### 🔎 Second-opinion review: ${VERDICT_ICON[o.verdict]} ${VERDICT_LABEL[o.verdict]}`,
        `${TIER_ICON[o.tier]} ${o.tier} tier · reviewer: ${REVIEW_MODEL} (did not write this change) · commit \`${o.sha.slice(0, 7)}\``,
        '',
        (o.findings || '').trim() || 'No findings.',
    ].join('\n');
}

export interface ReviewRecord { sha: string; verdict: ReviewVerdict; tier: ReviewTier; at: string; url: string | null }

/** Only comments from people with write access to the repo count: the repo is public, so anyone could post
 *  a marker. Claude posts through the owner's gh account (OWNER). */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface ReviewComment { body?: string | null; createdAt?: string | null; url?: string | null; authorAssociation?: string | null }

/** Every review comment on the PR from a trusted author, oldest first. */
export function parseReviews(comments: ReviewComment[]): ReviewRecord[] {
    const out: ReviewRecord[] = [];
    for (const c of comments || []) {
        if (!TRUSTED_ASSOCIATIONS.has(String(c.authorAssociation || '').toUpperCase())) continue;
        const m = MARKER_RE.exec(String(c.body || ''));
        if (m) out.push({ sha: m[1], verdict: m[2] as ReviewVerdict, tier: m[3] as ReviewTier, at: String(c.createdAt || ''), url: c.url || null });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface GateInput { tier: ReviewTier; base: string; headSha: string; reviews: ReviewRecord[]; override?: string | null }
export interface GateResult {
    ok: boolean;
    /** Why it is blocked (when !ok). */
    reason: string | null;
    /** One line for the approval note / PR check: tier + review state. */
    summary: string;
    /** The commit the verdict is for, when there is one: the Approve click merges only that commit. */
    reviewedSha: string | null;
    review: ReviewRecord | null;
}

const short = (s: string) => s.slice(0, 7);

/** May Claude ask the owner to approve this PR? */
export function reviewGate(g: GateInput): GateResult {
    const tierText = `${TIER_ICON[g.tier]} ${g.tier[0].toUpperCase()}${g.tier.slice(1)} tier`;
    const latest = g.reviews.length ? g.reviews[g.reviews.length - 1] : null;
    const forHead = [...g.reviews].reverse().find((r) => r.sha === g.headSha) || null;
    if (g.base === 'main') return { ok: true, reason: null, summary: `${tierText} · release/hotfix into main: each change was reviewed as its staging PR`, reviewedSha: null, review: forHead };
    if (g.tier === 'low') return { ok: true, reason: null, summary: `${tierText} · second-opinion review not needed`, reviewedSha: forHead?.sha || null, review: forHead };
    if (!forHead) {
        const reason = latest
            ? `The PR changed after its review (reviewed ${short(latest.sha)}, now ${short(g.headSha)}). Run the code-reviewer agent again on the new commit.`
            : `A ${g.tier} tier PR needs a second-opinion review first: run the code-reviewer agent on it (it records its verdict with scripts/pr-tier.ts record-review).`;
        return { ok: false, reason, summary: `${tierText} · ⚠️ no review for commit ${short(g.headSha)}`, reviewedSha: null, review: null };
    }
    const label = `🔎 Review: ${VERDICT_ICON[forHead.verdict]} ${VERDICT_LABEL[forHead.verdict]} (${REVIEW_MODEL})`;
    const tail = `reviewed commit ${forHead.sha}${forHead.url ? `\n${forHead.url}` : ''}`;
    if (forHead.verdict === 'changes') {
        const why = (g.override || '').replace(/\s+/g, ' ').trim();
        if (why.length < 10) return { ok: false, reason: 'The review says Changes needed. Fix the findings and review again, or pass --override-review "<why it is safe anyway>" (the owner sees it).', summary: `${tierText} · ${label}`, reviewedSha: forHead.sha, review: forHead };
        return { ok: true, reason: null, summary: `${tierText} · ${label} · ⚠️ Claude asks anyway: ${why}\n${tail}`, reviewedSha: forHead.sha, review: forHead };
    }
    return { ok: true, reason: null, summary: `${tierText} · ${label}\n${tail}`, reviewedSha: forHead.sha, review: forHead };
}

/** The commit an approval note says was reviewed, so the Approve click merges only that commit. */
export function reviewedShaFromNote(note: string | null | undefined): string | null {
    const m = /reviewed commit ([0-9a-f]{40})\b/.exec(String(note || ''));
    return m ? m[1] : null;
}

/** The approval note: the gate's summary first, then Claude's own note. */
export function approvalNoteWithReview(gate: GateResult, why: string | null): string {
    return [gate.summary, (why || '').trim()].filter(Boolean).join('\n\n');
}
