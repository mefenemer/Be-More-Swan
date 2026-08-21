-- db/webhooks.sql
-- Telling a tenant's own systems what just happened in their audience.
-- Requires db/audience.sql.
--
-- ── ⚠️ THE RETRY WORKER IS THE WHOLE DESIGN PROBLEM ─────────────────────────────────────────────
-- This feature was deliberately left unbuilt twice, for one reason: outbound webhooks need retries,
-- retries need something that runs on a schedule, and a schedule whose failure is SILENT has taken
-- two features out in this codebase already (db/... the retention and blank-draft sweeps, neither of
-- which ran once). "We deliver eventually" is a promise made by a background process nobody watches.
--
-- So the retry story is designed first, and it is three things:
--
--   1. THE FIRST ATTEMPT IS INLINE, at the moment of the event. Most deliveries succeed there, so
--      the queue below holds failures rather than traffic — a queue that is normally empty is a
--      queue whose backlog means something.
--   2. RETRIES DRAIN ON AN EXISTING SWEEP (process-newsletter-sends, every 5 minutes), not a new
--      schedule. No new thing to stop running.
--   3. ⚠️ A FAILING ENDPOINT BECOMES THE TENANT'S PROBLEM, VISIBLY. After
--      MAX_CONSECUTIVE_FAILURES the endpoint is disabled and a notification is raised. The failure
--      mode is not "deliveries quietly stop" — it is "you are told your endpoint is broken".
--
-- ⚠️ THE SIGNING SECRET IS NOT IN THIS TABLE. It has to be recoverable to sign with, so it lives in
-- the vault (src/utils/vault.ts) under `secret_ref`, encrypted with a per-row data key. An API key
-- can be hashed because we only ever compare it; a signing secret must be read back.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'audience_contacts') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/webhooks.sql requires db/audience.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only audience.sql   (then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                   SERIAL PRIMARY KEY,
  organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  url                  TEXT NOT NULL,
  description          TEXT,
  -- Comma-separated event names from a closed list. A row per event would be tidier and would also
  -- mean four rows to keep in step every time somebody edits one endpoint.
  events               TEXT NOT NULL DEFAULT 'contact.subscribed,contact.unsubscribed',
  -- Vault ref, not the secret. See the header.
  secret_ref           TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  -- Reset to zero by any success. This is what auto-disable counts.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_at          TIMESTAMP,
  disabled_reason      TEXT,
  last_success_at      TIMESTAMP,
  last_error           TEXT,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT now(),
  updated_at           TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  endpoint_id     INTEGER NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  -- The exact body that was (or will be) signed and sent. Stored so a retry sends the SAME bytes:
  -- rebuilding the payload later would re-read a contact who has since changed, and a receiver
  -- would get an event describing a state that never existed at that moment.
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP NOT NULL DEFAULT now(),
  response_status INTEGER,
  last_error      TEXT,
  delivered_at    TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_status_check') THEN
    ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_check
      CHECK (status IN ('pending','delivered','failed'));
  END IF;
END $$;

-- The drain query: what is pending and due.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (status, next_attempt_at);

-- The tenant's own view of one endpoint's recent history.
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx
  ON webhook_deliveries (endpoint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS webhook_endpoints_org_idx
  ON webhook_endpoints (organisation_id, is_active);

-- Verify:
--   SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'webhook_%';
