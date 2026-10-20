-- db/z-login-events.sql — one row each time someone signs in (a session cookie is issued).
-- Code: src/utils/login-events.ts (the one writer), called from netlify/functions/verify.ts (magic
-- link), review-login.ts (platform reviewer password) and accept-invite.ts (invite accepted).
-- Drizzle mirror: db/schema.ts (loginEvents).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Safe to deploy before or after: the writer
-- catches a missing table and never blocks a login, so running the code first only means logins
-- are not recorded yet.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-login-events                              (staging)
--   npm run db:migrate:apply -- --only z-login-events --url-var DATABASE_URL_PROD  (prod)
--
-- Why it exists (2026-10-20): "who logged in today?" had no answer. Sessions are a stateless signed
-- cookie, and users.last_magic_link_sent_at keeps only the latest link request.
--
-- org-switch.ts re-signs an existing session and is deliberately NOT a login.
-- ip is TRUNCATED before storage (src/utils/ip-pseudonymise.ts), as the privacy policy promises.
-- created_at is naive UTC, like the rest of the schema.

BEGIN;

CREATE TABLE IF NOT EXISTS login_events (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organisation_id  INTEGER REFERENCES organisations(id) ON DELETE SET NULL,
    method           TEXT NOT NULL CHECK (method IN ('magic_link', 'review_login', 'invite')),
    ip               TEXT,
    user_agent       TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS login_events_created_idx ON login_events (created_at DESC);
CREATE INDEX IF NOT EXISTS login_events_user_idx    ON login_events (user_id, created_at DESC);

COMMIT;
