-- Migration: Gamification & Engagement (onboarding flag, milestone rewards, config seed).
-- Applied manually (like db/onboarding-drafts-multidraft.sql / db/referral-rewards.sql) rather than via
-- `drizzle-kit push`, which would also try to DISABLE RLS on ai_assistants (RLS lives in db/rls/).
-- Idempotent: safe to re-run.

-- ── organisations: gamification columns ──────────────────────────────────────
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false;   -- AC1.1.3
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS beta_access boolean NOT NULL DEFAULT false;            -- AC3.1.2
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS bonus_referral_tokens integer NOT NULL DEFAULT 0;      -- AC3.1.3

-- Backfill: existing workspaces that already have an assistant have effectively finished onboarding,
-- so the 3-step widget should not pop for them.
UPDATE organisations o SET onboarding_completed = true
WHERE onboarding_completed = false
  AND EXISTS (SELECT 1 FROM ai_assistants a WHERE a.organisation_id = o.id);

-- ── reward_audits: milestone grant log + dedup (AC4.2.1) ─────────────────────
CREATE TABLE IF NOT EXISTS reward_audits (
  id serial PRIMARY KEY,
  organisation_id integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  reward_type text NOT NULL,        -- 'referral_token' | 'beta_access'
  trigger_event text NOT NULL,      -- 'milestone:100_leads' | 'milestone:50_hours'
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reward_audits_org_trigger_unique ON reward_audits(organisation_id, trigger_event);
CREATE INDEX IF NOT EXISTS reward_audits_created_idx ON reward_audits(created_at);

-- ── platform_config seed rows: admin-editable multipliers/thresholds (AC4.1.1) + emergency stop (AC4.2.3) ──
INSERT INTO platform_config (key, value) VALUES
  ('gamification.time_multipliers', '{"leads_generated":3,"content_drafted":5,"tasks_completed":2}'::jsonb),
  ('gamification.milestones',       '{"leads_for_token":100,"hours_for_beta":50}'::jsonb),
  ('gamification.rewards_paused',   'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
