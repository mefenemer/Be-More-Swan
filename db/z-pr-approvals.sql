-- db/z-pr-approvals.sql — the approval record (docs/review-tiers-plan.md, Phase 3; owner 2026-11-17).
-- One row per merged PR (staging or main): its risk tier, the second-opinion verdict for the commit that
-- merged, and how it was approved (the admin Approve button, or merged some other way, e.g. `gh pr merge`
-- on the owner's word). Written by src/utils/pr-approvals.ts; shown on Admin → Systems → Approvals.
-- Additive only. Run on BOTH databases (staging and prod). Not in db/schema.ts (raw SQL behind
-- prApprovalsReady(), like the other pipeline tables).

CREATE TABLE IF NOT EXISTS pr_approvals (
    id serial PRIMARY KEY,
    repo text NOT NULL,
    pr_number integer NOT NULL,
    base text,
    title text,
    url text,
    tier text,
    tier_reason text,
    head_sha text,
    reviewer_verdict text,
    reviewer_sha text,
    review_url text,
    approved_via text NOT NULL DEFAULT 'other',
    approved_by text,
    approved_sha text,
    merged_at timestamptz,
    merged_sha text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pr_approvals_repo_pr ON pr_approvals (repo, pr_number);
CREATE INDEX IF NOT EXISTS pr_approvals_merged_at ON pr_approvals (merged_at DESC);
