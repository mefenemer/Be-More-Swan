-- db/newsletter-dispatch.sql
-- Phase 4 of docs/newsletter-assistant-plan.md — sending identity, and the two columns the send
-- worker needs on the existing tables. Requires db/audience.sql and db/newsletter.sql.
--
-- ── The decision this encodes (§6, option 2) ────────────────────────────────────────────────────
-- Broadcast goes out through Resend from a domain the TENANT has verified, because that is what
-- Gmail and Yahoo require of bulk senders and what keeps one tenant's complaint rate off Be More
-- Swan's own transactional mail. A tenant with no verified domain may still send to a small list
-- from their own connected mailbox — the route the Lead Generator already uses for 1:1 outreach —
-- hard-capped, because a personal mailbox has daily limits and no bounce feedback at all.
--
-- ⚠️ NOT organisations.domain_verified. That column (db/org-business-domain.sql) already means
-- "verified for same-domain org auto-join" — a different claim about a different thing. One boolean
-- with two meanings is the shape of several bugs already in this codebase's history.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner, staging first. SQL before code.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'newsletter_issues') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-dispatch.sql requires db/audience.sql and db/newsletter.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only audience   (then --only newsletter, then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS newsletter_sending_domains (
  id                  SERIAL PRIMARY KEY,
  organisation_id     INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- The subdomain the tenant sends from, e.g. 'mail.acme.com'. A subdomain by convention, never
  -- the root: a bad campaign must not be able to take down the domain their invoices come from.
  domain              TEXT NOT NULL,
  -- Resend's own id for the domain, so verification can be re-checked without guessing.
  provider            TEXT NOT NULL DEFAULT 'resend',
  provider_domain_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  -- The DNS records the tenant has to add, exactly as the provider returned them. Stored rather
  -- than re-fetched so the setup screen still works when the provider API is unreachable.
  dns_records         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- What the recipient sees. from_local_part is the mailbox: 'hello' → hello@mail.acme.com.
  from_name           TEXT,
  from_local_part     TEXT NOT NULL DEFAULT 'hello',
  reply_to            TEXT,
  last_checked_at     TIMESTAMP,
  verified_at         TIMESTAMP,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  -- One row per (org, domain). A tenant may register several domains over time; only a verified
  -- one can send, and the send path picks the most recently verified.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sending_domains_org_domain_unique') THEN
    ALTER TABLE newsletter_sending_domains ADD CONSTRAINT newsletter_sending_domains_org_domain_unique
      UNIQUE (organisation_id, domain);
  END IF;

  -- 'failed' is a provider-side rejection (a domain already claimed elsewhere, a malformed name);
  -- 'pending' just means the DNS records are not visible yet, which is the normal first state.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sending_domains_status_check') THEN
    ALTER TABLE newsletter_sending_domains ADD CONSTRAINT newsletter_sending_domains_status_check
      CHECK (status IN ('pending','verified','failed','disabled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS newsletter_sending_domains_org_idx
  ON newsletter_sending_domains (organisation_id, status);

-- ── Which route actually sent it ────────────────────────────────────────────────────────────────
-- On the issue for reporting, on the ledger row because a single issue can legitimately be sent by
-- one route and re-sent by another after a domain is verified. Without this, "why did this land in
-- spam?" has no answer six weeks later.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS send_provider TEXT;
ALTER TABLE newsletter_sends  ADD COLUMN IF NOT EXISTS provider      TEXT;

-- Why a send stopped. ⚠️ Without this a failed issue is a status with no explanation — the exact
-- gap that made social post failures undiagnosable until scheduled_posts.failure_reason existed.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- The From address used, frozen per issue at send time. A tenant who later changes their sending
-- domain must not rewrite the record of what recipients actually saw.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS from_address TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_issues_send_provider_check') THEN
    ALTER TABLE newsletter_issues ADD CONSTRAINT newsletter_issues_send_provider_check
      CHECK (send_provider IS NULL OR send_provider IN ('resend','gmail','outlook'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sends_provider_check') THEN
    ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_provider_check
      CHECK (provider IS NULL OR provider IN ('resend','gmail','outlook'));
  END IF;
END $$;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'newsletter_sending_domains' ORDER BY ordinal_position;
--   SELECT conname FROM pg_constraint WHERE conrelid = 'newsletter_issues'::regclass;
