-- db/z-partner-activity.sql — Partner Terms 1.3 §7.5 "Staying active": the activity clock, inactivity
-- notices, how a partnership ended (for the §7.2 / §7.5(h) run-off) and when the current partnership
-- began (for §7.5(i) re-approval). Drizzle mirror: db/schema.ts (partners). Logic: src/utils/partner-activity.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-partner-activity.sql                              (staging)
--   npm run db:migrate:apply -- --only z-partner-activity.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql and db/z-affiliate-partner-ended.sql first.
--
--   approved_at            most recent move to 'approved' (first approval, reinstatement, re-approval) — §7.5(c)(i)
--   partner_since          start of the CURRENT partnership (first approval, or re-approval after ending) —
--                          tenure for §7.5(d) notice length, and §7.5(i): customers who first paid before it earn nothing
--   ended_at, end_reason   when and why it ended: inactivity (§7.5) | closure (§7.2) | left (§7.1) | breach (§7.2) | other
--   activity_pause_days    days that don't count towards the 6 months (suspended, or sign-ups paused) — §7.5(c)
--   activity_pause_last_day  the last day counted into activity_pause_days (keeps the nightly tick idempotent)
--   activity_pause_anchor    the clock start those paused days belong to; a new start (approval, new customer) resets them
--   inactivity_notice_at / inactivity_notice_ends   an open §7.5 notice; cleared when withdrawn

BEGIN;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS partner_since TIMESTAMP;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS end_reason TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS activity_pause_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS activity_pause_last_day DATE;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS activity_pause_anchor TIMESTAMP;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS inactivity_notice_at TIMESTAMP;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS inactivity_notice_ends TIMESTAMP;

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_end_reason_check;
ALTER TABLE partners ADD CONSTRAINT partners_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('inactivity', 'closure', 'left', 'breach', 'other'));

-- Existing partners (none at 1.3, but staging may have test ones): their last decision stands in for both dates.
UPDATE partners SET approved_at = COALESCE(decided_at, created_at)
 WHERE approved_at IS NULL AND status IN ('approved', 'suspended', 'ended');
-- partner_since from the APPLICATION date: decided_at moves on every suspend/reinstate, and a later
-- partner_since would cut off customers who first paid before it (§7.5(i)). Earlier is always safe.
UPDATE partners SET partner_since = created_at
 WHERE partner_since IS NULL AND approved_at IS NOT NULL;
UPDATE partners SET ended_at = COALESCE(decided_at, updated_at), end_reason = COALESCE(end_reason, 'other')
 WHERE status = 'ended' AND ended_at IS NULL;

COMMIT;

-- Check: SELECT column_name FROM information_schema.columns WHERE table_name = 'partners'
--          AND column_name IN ('approved_at','partner_since','ended_at','end_reason','activity_pause_days',
--                              'activity_pause_last_day','activity_pause_anchor','inactivity_notice_at','inactivity_notice_ends');  → 9 rows
