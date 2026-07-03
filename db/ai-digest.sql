-- AI approvals email digest opt-in (Epic 3 US8).
--
-- organisations.ai_digest_frequency controls the AI review digest cadence: 'off' (default) | 'daily'
-- | 'weekly'. The ai-approvals-digest.ts cron emails the workspace owner a summary of pending
-- AI-drafted posts on the chosen cadence, and sends NOTHING when there is nothing to review
-- (zero-spam rule).
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push).

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS ai_digest_frequency TEXT NOT NULL DEFAULT 'off';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organisations_ai_digest_frequency_check') THEN
    ALTER TABLE organisations
      ADD CONSTRAINT organisations_ai_digest_frequency_check
      CHECK (ai_digest_frequency IN ('off', 'daily', 'weekly'));
  END IF;
END $$;
