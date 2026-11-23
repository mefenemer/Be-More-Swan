-- db/z-partner-onboarding.sql — Partner onboarding (docs/partner-onboarding-plan.md, Phase 1).
-- Drizzle mirror: db/schema.ts (partners.onboarding).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-partner-onboarding.sql                              (staging)
--   npm run db:migrate:apply -- --only z-partner-onboarding.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first.
--
-- The "Your first week" checklist on the Partner page ticks itself from real data. Most steps are
-- already recorded elsewhere (Terms accepted, payout details confirmed, visits, sign-ups, paying
-- customers). This column holds the few that aren't, as ISO timestamps:
--   { "link_copied_at": "...", "first_draft_at": "...", "dismissed_at": "..." }
-- Written only by partner-hub.ts (the partner's own row) and partner-assistant.ts (first draft).

ALTER TABLE partners ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Check: SELECT column_name, data_type, column_default FROM information_schema.columns
--         WHERE table_name = 'partners' AND column_name = 'onboarding';
--   → onboarding | jsonb | '{}'::jsonb
