-- db/z-beta-endings.sql — Ending the beta, one workspace at a time (Admin → Customers → Beta testers).
-- Code: src/utils/beta-ending.ts, netlify/functions/admin-beta.ts, netlify/functions/end-beta-sweep.ts.
-- Drizzle mirror: db/schema.ts (betaEndings).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-beta-endings                              (staging)
--   npm run db:migrate:apply -- --only z-beta-endings --url-var DATABASE_URL_PROD  (prod)
--
-- One row per beta workspace once an admin has set it up. Decided by the owner 2026-10-13:
--   • the end date (so the notice period) is set PER WORKSPACE;
--   • only an admin sends the notice and the reminder — nothing emails a tester by itself;
--   • a workspace is only ever ended if its notice was sent (end-beta-sweep checks notice_sent_at).
-- ended_at: the beta plan was expired and assistants paused. converted_at: they subscribed
-- afterwards and their assistants were switched back on. Publishing is held between the two.

BEGIN;

CREATE TABLE IF NOT EXISTS beta_endings (
    id                  SERIAL PRIMARY KEY,
    organisation_id     INTEGER NOT NULL UNIQUE REFERENCES organisations(id) ON DELETE CASCADE,
    ends_on             DATE NOT NULL,
    offered_tier_key    TEXT,
    coupon_code         TEXT,
    notice_sent_at      TIMESTAMP,
    notice_sent_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reminder_sent_at    TIMESTAMP,
    reminder_sent_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ended_at            TIMESTAMP,
    converted_at        TIMESTAMP,
    created_at          TIMESTAMP NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS beta_endings_due_idx ON beta_endings (ends_on) WHERE ended_at IS NULL;

-- Assistants paused because their workspace's beta ended carry provisioning_status
-- 'paused_beta_ended' (only those are switched back on when the workspace subscribes). The lifecycle
-- is derived from provisioning_status by assistant_lifecycle_from_legacy(); without this it would
-- fall through to 'provisioning' and the workspace would show the assistant as still being built.
-- Same body as db/assistant-quota-pause.sql (verified against prod 2026-10-13) plus the new value,
-- and 'blocked' kept explicit as in db/assistant-provisioning-blocked.sql (same result either way).
CREATE OR REPLACE FUNCTION assistant_lifecycle_from_legacy(ps text, active boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN ps = 'cancelled'                                                             THEN 'archived'
    WHEN ps IN ('paused_payment','paused_limit','paused_quota','paused_beta_ended')   THEN 'system_paused'
    WHEN ps IN ('pending','pending_payment','failed','blocked') OR ps IS NULL         THEN 'provisioning'
    WHEN ps = 'complete' AND active                                                   THEN 'working'
    WHEN ps = 'complete' AND NOT active                                               THEN 'paused'
    ELSE 'provisioning'
  END
$$;

COMMIT;
