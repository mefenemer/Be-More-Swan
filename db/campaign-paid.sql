-- db/campaign-paid.sql — Campaign Assistant, Phase C: the paid rails, built DARK.
-- Design: docs/campaign-orchestrator-plan.md §7 Phase 3. Config: src/config/ad-networks.ts.
-- Drizzle mirror: db/schema.ts (adVariants / adVariantMetrics + new campaigns columns).
--
-- APPLY MANUALLY as the DB owner. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only campaign-paid
--
-- ⚠️ APPLYING THIS UNLOCKS NOTHING. There is no reachable ad network: the adapter registry
-- (src/utils/ad-networks/registry.ts) is empty in production, and the whole surface sits behind the
-- `paid_ads` plan feature which is off by absence. These tables exist so the machinery above them
-- can be written and tested now, against a mock, rather than written blind on the day LinkedIn
-- grants Marketing Developer Platform access. Rows here will stay at zero until then.
--
-- ── Why this file widens no CHECK constraint ─────────────────────────────────
-- "Control lost" is a real state a paid campaign can be in — the ad account stopped answering
-- while money keeps going out — and the obvious move is to add it to campaigns_status_check. That
-- would be wrong twice over:
--
--   1. Modelling: it is ORTHOGONAL to status, not another value of it. The dangerous case is
--      precisely a campaign that is still ACTIVE and no longer controllable. A status can only say
--      one of those at a time, so folding them together loses the fact that matters.
--   2. Migration safety: widening a CHECK means DROP-then-ADD, and a DROP-then-ADD that fails
--      part-way leaves the rest of the file silently unapplied — this codebase has a half-applied
--      production migration from exactly that shape.
--
-- So control lives in its own additive column with its own constraint. Everything below is either
-- a new column or a new table; nothing existing is altered.

BEGIN;

-- ── Campaigns gain their network identity and their watchdog ─────────────────
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ad_network            TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS external_campaign_id  TEXT;

-- 'ok' | 'lost'. Whether we can still STOP this campaign.
-- ⚠️ The whole point of this column: a dead token on an organic campaign is an inconvenience; on a
-- paid one it means the network keeps charging the customer and the kill switch no longer reaches
-- anything. It must be a state we can see BEFORE we need to act, never something discovered when
-- a pause fails.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS control_state         TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS control_checked_at    TIMESTAMP;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS control_detail        TEXT;

-- When the optimiser last successfully examined this campaign.
-- ⚠️ Read by assessHeartbeat(). A paid campaign whose optimiser has gone quiet HALTS ITSELF: a
-- cron that stops running is invisible here, and its invisibility is the danger — every guardrail
-- silently stops being enforced while the spend continues. Two nightly sweeps in this codebase
-- never ran for weeks and nothing noticed.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS optimiser_last_run_at TIMESTAMP;

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_control_state_check;
ALTER TABLE campaigns ADD  CONSTRAINT campaigns_control_state_check
  CHECK (control_state IN ('ok','lost'));

-- ── Ad variants: the creatives, and their approval state ─────────────────────
CREATE TABLE IF NOT EXISTS ad_variants (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id           INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  -- The tracked link this creative points at, so clicks land in the attribution ledger rather than
  -- only in the network's own reporting. Nullable: a variant can be drafted before its link exists.
  link_id               INTEGER REFERENCES campaign_links(id) ON DELETE SET NULL,

  network               TEXT NOT NULL,
  external_variant_id   TEXT,

  -- The creative. Written by the assistant, editable by a human before approval.
  headline              TEXT NOT NULL,
  body                  TEXT NOT NULL,
  -- 'thought_leader' | 'single_image' | 'video_script' — the brief's three variants (AC 1.3).
  format                TEXT NOT NULL DEFAULT 'single_image',
  targeting             JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ⚠️ 'staged' IS NOT 'paused'. staged = built and pushed to the network paused, never spent a
  -- penny, never approved. paused = it ran and was stopped. Collapsing them would make "never
  -- launched" and "launched and stopped" identical in every report, and would let a Resume button
  -- start something no human ever approved.
  status                TEXT NOT NULL DEFAULT 'staged',
  pause_reason          TEXT,

  -- Who approved it, and when. NULL on anything that has never been live — this pair is the audit
  -- trail for "a human authorised this spend".
  approved_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMP,

  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT ad_variants_status_check
    CHECK (status IN ('staged','active','paused','archived','rejected')),
  CONSTRAINT ad_variants_pause_reason_check
    CHECK (pause_reason IS NULL OR pause_reason IN ('creative_fatigue','cost_per_outcome','budget_exhausted','human','control_lost')),
  -- A variant that has ever been live must name who approved it. This is the database half of the
  -- human-in-the-loop rule: without it, "approved" is a field the application promises to set.
  CONSTRAINT ad_variants_approval_check
    CHECK (status NOT IN ('active','paused') OR approved_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ad_variants_campaign_idx ON ad_variants (campaign_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ad_variants_external_uidx
  ON ad_variants (external_variant_id) WHERE external_variant_id IS NOT NULL;

-- ── Daily metrics: APPEND-ONLY, one row per variant per day ──────────────────
-- Stored rather than re-fetched: the optimiser needs a 7-day window every day, and re-pulling it
-- from the network on every run multiplies our rate-limit exposure by seven for no benefit. It
-- also means the evidence behind a pause survives, so "why did you stop my ad" has an answer that
-- does not depend on the network still reporting the same numbers.
CREATE TABLE IF NOT EXISTS ad_variant_metrics (
  id                    BIGSERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  variant_id            INTEGER NOT NULL REFERENCES ad_variants(id) ON DELETE CASCADE,

  -- The NETWORK's day boundary, kept as a date rather than a timestamp: ad platforms report in
  -- their account's timezone and converting would invent precision we do not have.
  day                   DATE NOT NULL,
  impressions           INTEGER NOT NULL DEFAULT 0,
  clicks                INTEGER NOT NULL DEFAULT 0,
  spend_gbp             NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  -- ⚠️ What the NETWORK claims, kept separate from our own attributed conversions. They will
  -- disagree — every ad platform counts view-through conversions we cannot see, and we count
  -- conversions it cannot. Storing one number for both would silently pick a winner.
  reported_conversions  INTEGER NOT NULL DEFAULT 0,

  fetched_at            TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT ad_variant_metrics_nonneg_check
    CHECK (impressions >= 0 AND clicks >= 0 AND spend_gbp >= 0 AND reported_conversions >= 0)
);
-- One row per variant per day. A re-fetch UPSERTs rather than appending a second row, or every
-- rate would be divided by a doubled denominator.
CREATE UNIQUE INDEX IF NOT EXISTS ad_variant_metrics_day_uidx
  ON ad_variant_metrics (variant_id, day);

COMMIT;

-- ── Row-level security: deliberately NOT enabled here ────────────────────────
-- Same reasoning as db/campaigns.sql and db/campaign-attribution.sql, and it must stay identical:
-- the application connects as the table OWNER, an owner BYPASSES RLS, so a policy here would read
-- as protection while never evaluating. Isolation is requireTenant() + organisation_id scoping +
-- an IDOR re-check on any caller-supplied id.
