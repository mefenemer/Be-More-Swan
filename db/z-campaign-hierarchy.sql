-- db/z-campaign-hierarchy.sql — umbrella campaigns, always-on campaigns. Plan §9.4.
-- Drizzle mirror: db/schema.ts (campaigns.parentCampaignId, campaigns.alwaysOn).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-campaign-hierarchy                              (staging)
--   npm run db:migrate:apply -- --only z-campaign-hierarchy --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ Deploy order: campaigns.ts `requireCampaign()` selects every mirrored campaigns column.
--
-- ── parent_campaign_id ──────────────────────────────────────────────────────
-- "Summer Rebrand" contains a webinar, a paid burst and a blog series. ONE level only (umbrella →
-- child): enforced at the HTTP boundary, because a CHECK cannot see another row. ON DELETE SET
-- NULL: removing an umbrella must never take its campaigns (and their history) with it.
-- Budgets do NOT roll down: each campaign keeps its own task ceiling, so moving effort inside one
-- can never cannibalise another — the review's concern is met by construction. Roll-ups on the
-- umbrella are read-only sums.
--
-- ── always_on ───────────────────────────────────────────────────────────────
-- Business-as-usual campaigns that run underneath everything. Always-on means NO end date (the
-- boundary clears ends_at), which is also exactly why the reconciler's finish sweep — it only
-- finishes campaigns past a non-null ends_at — never touches one. The column exists so the year
-- view can draw it as a band and the row can say what it is, not to change the sweep.
--
-- Both CHECKs are inline on their columns, so a re-run skips them with the column: no DROP-then-ADD.

BEGIN;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS parent_campaign_id INTEGER
  REFERENCES campaigns(id) ON DELETE SET NULL
  CONSTRAINT campaigns_parent_not_self_check CHECK (parent_campaign_id IS NULL OR parent_campaign_id <> id);
CREATE INDEX IF NOT EXISTS campaigns_parent_idx ON campaigns (parent_campaign_id) WHERE parent_campaign_id IS NOT NULL;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS always_on BOOLEAN NOT NULL DEFAULT FALSE
  CONSTRAINT campaigns_always_on_no_end_check CHECK (NOT always_on OR ends_at IS NULL);

COMMIT;

-- RLS: deliberately not enabled, as for every campaign table — see the foot of db/campaigns.sql.
