-- db/z-partner-invite-page.sql — A partner's own invite page (docs/partner-onboarding-plan.md §3.3, Phase 2).
-- Drizzle mirror: db/schema.ts (partners.invite_profile*).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-partner-invite-page.sql                              (staging)
--   npm run db:migrate:apply -- --only z-partner-invite-page.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first. Several functions select every partners column, so
--    without these columns the Partner page, the Partner Assistant and Admin → Partners return 500.
--
-- /invite/<code> can show the partner's photo, a headline and a short quote in their own words. It is
-- on OUR domain, so it goes live only after an admin approves it (owner decision D4, 2026-11-22):
--   invite_profile          what the public page shows — the last APPROVED version (null = standard page)
--   invite_profile_pending  what they submitted and is waiting for review, or was sent back with a note
--   invite_profile_note     the admin's note when asking for changes (shown to the partner); null = waiting
--   invite_profile_reviewed_at  when an admin last approved / asked for changes
-- Each profile is { "headline": text, "quote": text, "photoKey": text|null, "submittedAt": iso }.
-- photoKey is an R2 object key under partner-photos/<partnerId>/ — served by partner-photo.ts.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS invite_profile jsonb;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invite_profile_pending jsonb;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invite_profile_note text;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invite_profile_reviewed_at timestamp;

-- Check: SELECT column_name, data_type FROM information_schema.columns
--         WHERE table_name = 'partners' AND column_name LIKE 'invite_profile%' ORDER BY 1;
--   → invite_profile jsonb | invite_profile_note text | invite_profile_pending jsonb | invite_profile_reviewed_at timestamp
