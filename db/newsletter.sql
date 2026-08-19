-- db/newsletter.sql
-- Newsletter Assistant (role_key 'newsletter_editor') — the issue content model and the per-recipient
-- send ledger. Phase 0 of docs/newsletter-assistant-plan.md. Requires db/audience.sql.
--
-- Deliberately mirrors db/blog-posts.sql: same status vocabulary, same reuse of the shared content
-- infrastructure (content_generation_jobs.job_id, ai_blueprints.blueprint_id, content_provenance,
-- pending_actions for HITL, audit_logs). An issue is a blog post that is mailed instead of published.
--
-- ⚠️ newsletter_sends is the UNIT OF WORK for dispatch, not a log written afterwards. One row per
-- recipient is minted BEFORE anything is sent, and the (issue_id, email) unique constraint is what
-- makes a partially-failed batch resumable instead of duplicative. The blog pipeline learned this
-- the expensive way: 5 jobs produced 9 published posts on production because a claim that was not
-- atomic looked exactly like one that was.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner — no drizzle-kit push. SQL to BOTH
-- databases BEFORE the code deploys.

CREATE TABLE IF NOT EXISTS newsletter_issues (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id          INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,   -- set for autonomous drafts
  owner_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_label           TEXT,                                  -- "AI: Newsletter Nina" | "Jane Smith"

  -- Body
  subject               TEXT NOT NULL,
  preheader             TEXT,                                  -- inbox preview line
  body_markdown         TEXT NOT NULL DEFAULT '',              -- editable source of truth
  -- Snapshot taken at APPROVAL: { html, text }. Sending must never re-render from body_markdown —
  -- a human approved these exact words, and an edit landing mid-send would ship two versions.
  rendered_payload      JSONB,

  -- Audience targeting. NULL segment = every 'subscribed' contact in the org.
  segment_id            INTEGER REFERENCES audience_segments(id) ON DELETE SET NULL,

  -- Workflow & governance (mirrors blog_posts.status, minus the publish-only states)
  status                TEXT NOT NULL DEFAULT 'draft',
  scheduled_for         TIMESTAMP,
  sending_started_at    TIMESTAMP,
  sent_at               TIMESTAMP,
  is_autonomous         BOOLEAN NOT NULL DEFAULT false,
  generation_reason     TEXT,

  -- Provenance & AI linkage (reused infra — see db/blog-posts.sql)
  provenance_content_id TEXT,
  confidence_score      TEXT,                                  -- 'green' | 'amber' | 'red' | null
  factual_claims        JSONB,
  job_id                TEXT,                                  -- content_generation_jobs.job_id
  blueprint_id          INTEGER REFERENCES ai_blueprints(id) ON DELETE SET NULL,

  -- Outcome counters, maintained by the send worker and the provider webhook. Denormalised on
  -- purpose: the KPI cards must not COUNT(*) a send ledger of hundreds of thousands of rows.
  recipient_count       INTEGER NOT NULL DEFAULT 0,
  delivered_count       INTEGER NOT NULL DEFAULT 0,
  opened_count          INTEGER NOT NULL DEFAULT 0,
  clicked_count         INTEGER NOT NULL DEFAULT 0,
  bounced_count         INTEGER NOT NULL DEFAULT 0,
  complained_count      INTEGER NOT NULL DEFAULT 0,
  unsubscribed_count    INTEGER NOT NULL DEFAULT 0,

  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_issues_status_check') THEN
    ALTER TABLE newsletter_issues ADD CONSTRAINT newsletter_issues_status_check
      CHECK (status IN ('draft','pending_approval','in_review','approved','scheduled',
                        'sending','sent','paused','failed','rejected','archived'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS newsletter_issues_org_status_idx ON newsletter_issues (organisation_id, status);
CREATE INDEX IF NOT EXISTS newsletter_issues_assistant_idx  ON newsletter_issues (assistant_id, created_at DESC);
-- The dispatch cron's claim query: issues that are due.
CREATE INDEX IF NOT EXISTS newsletter_issues_due_idx        ON newsletter_issues (status, scheduled_for);

-- ── Per-recipient send ledger ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter_sends (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  issue_id              INTEGER NOT NULL REFERENCES newsletter_issues(id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: erasing a contact must not destroy the org's record that an
  -- issue went out to N people (and the address is kept here in its own right for bounce matching).
  contact_id            INTEGER REFERENCES audience_contacts(id) ON DELETE SET NULL,
  email                 TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued',
  -- Why a recipient was NOT mailed. 'skipped' with no reason is the shape of a silent bug.
  skip_reason           TEXT,
  provider_message_id   TEXT,                                  -- for webhook reconciliation
  -- Per-(issue,contact) unsubscribe credential. Mirrors lead_threads.replyToken: unique, NOT NULL,
  -- ROTATED rather than cleared when revoked.
  unsubscribe_token     TEXT NOT NULL,
  error                 TEXT,
  sent_at               TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  -- The idempotency key. A retried batch re-inserts and conflicts instead of double-sending.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sends_issue_email_unique') THEN
    ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_issue_email_unique
      UNIQUE (issue_id, email);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sends_token_unique') THEN
    ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_token_unique
      UNIQUE (unsubscribe_token);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sends_status_check') THEN
    ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_status_check
      CHECK (status IN ('queued','sent','delivered','bounced','complained','failed','skipped'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sends_skip_reason_check') THEN
    ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_skip_reason_check
      CHECK (skip_reason IS NULL OR skip_reason IN
        ('opted_out','suppressed','unconfirmed','not_in_audience','bounced_previously',
         'complained_previously','consent_check_failed','invalid_address','do_not_contact'));
  END IF;
END $$;

-- The claim query: the next queued slice of one issue.
CREATE INDEX IF NOT EXISTS newsletter_sends_issue_status_idx ON newsletter_sends (issue_id, status);
-- Webhook reconciliation arrives keyed on the provider's id or the address.
CREATE INDEX IF NOT EXISTS newsletter_sends_provider_idx     ON newsletter_sends (provider_message_id);
CREATE INDEX IF NOT EXISTS newsletter_sends_org_email_idx    ON newsletter_sends (organisation_id, email);

-- Verify:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'newsletter_issues' ORDER BY ordinal_position;
--   SELECT conname FROM pg_constraint WHERE conrelid = 'newsletter_sends'::regclass;
