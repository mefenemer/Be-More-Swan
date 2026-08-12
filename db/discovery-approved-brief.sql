-- Phase 0: the search brief a human approved before the run was allowed to spend anything.
--
-- ⚠️ MANUAL APPLY (npm run db:migrate:apply). No drizzle-kit push — see docs/db-migrations.md.
-- The matching column in db/schema.ts MUST stay in sync or a future push drops this.
--
-- ── Why this exists ──────────────────────────────────────────────────────────
-- A prod run on 2026-08-08 searched `site:trustpilot.com OR site:g2.com`,
-- `site:linkedin.com/jobs`, `inurl:careers OR inurl:jobs` and
-- `best social media agencies UK ... directories`. All 35 results were discarded or scored cold,
-- at full search-and-token cost. The queries were visible nowhere until after the money was spent:
-- discovery-query-gen.ts generated them INSIDE the job, and the only feedback channel a user had
-- was rejecting the leads afterwards.
--
-- This column holds what the user actually read and approved, so a run executes the plan that was
-- on screen rather than one nobody ever saw.
--
-- Shape:
--   {
--     "queries":   { "niche_scrape": [...], "intent_signal": [...], "footprint": [...] },
--     "persona":   {...},          -- the target persona it was approved against
--     "exclusions": { "negativeKeywords": [...], "excludedDomains": [...] },
--     "approvedAt": "2026-08-08T...",
--     "approvedBy": 123            -- users.id
--   }
--
-- ⚠️ NOT nested inside icp_snapshot. That column is the attribution key the revenue ledger stamps
-- onto every lead_discovered / lead_scored / lead_approved event; overloading it would change the
-- meaning of every row that carries it.
--
-- ⚠️ The stored queries are the FIRST run's concrete instance, not a script to replay. Re-running
-- the same query strings returns substantially the same domains, and the (campaign_id, domain)
-- unique index then discards all of them — a weekly campaign would find leads once and nothing
-- ever again. Scheduled runs regenerate queries steered BY this brief; only the first run has its
-- cursor seeded from it verbatim.
--
-- Additive and nullable: every existing campaign reads NULL, which the API treats as
-- "no brief approved yet". Idempotent — safe to re-run.

ALTER TABLE discovery_campaigns
    ADD COLUMN IF NOT EXISTS approved_brief jsonb;

COMMENT ON COLUMN discovery_campaigns.approved_brief IS
    'The search plan a human read and approved (queries + persona + exclusions). NULL = never approved. The first run is seeded from it; later runs regenerate steered by it.';
