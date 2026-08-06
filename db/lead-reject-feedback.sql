-- db/lead-reject-feedback.sql
-- Capture WHY a discovered lead was rejected in the Review Queue.
--
-- Before this table, a rejection wrote `assistant_records.approval_status = 'rejected'` and a
-- `lead_rejected` revenue event carrying {from,to,rating}. Neither records a reason, and nothing
-- reads the event to change behaviour — so twenty rejections in a row taught the discovery engine
-- exactly nothing.
--
-- Vocabulary source of truth: src/config/lead-reject-reasons.ts LEAD_REJECT_REASONS. The list
-- appears in THREE places (that file, db/schema.ts check(), and here); nothing across the TS/SQL
-- boundary enforces agreement, so tests/lead-reject-reasons.test.ts parses all three and asserts
-- they match.
--
-- Apply manually via scripts/db-migrate.mjs. For PROD, pass the connection explicitly — the runner
-- defaults to the local .env database and that database IS staging:
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only lead-reject-feedback --url-var PROD_DATABASE_URL --yes
--
-- ── Deploy ordering ─────────────────────────────────────────────────────────
-- APPLY BEFORE DEPLOY. The reject-reason strip calls an endpoint that inserts here; deploying the
-- code first gives every reviewer who picks a reason a silent failure (the writer swallows it, as
-- it must) and loses the evidence for that window entirely.

BEGIN;

CREATE TABLE IF NOT EXISTS lead_reject_feedback (
  id                  serial PRIMARY KEY,
  organisation_id     integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- The assistant whose targeting produced this lead. NOT NULL: it is the grouping key for any
  -- future aggregate, and assistant_records.ai_assistant_id is itself NOT NULL, so there is no
  -- path that legitimately lacks it.
  ai_assistant_id     integer NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  -- The rejected record. SET NULL rather than CASCADE: the evidence outlives the lead. A user who
  -- clears out old records must not silently delete the reasons the searches were meant to learn
  -- from — that is precisely the history worth keeping.
  assistant_record_id integer REFERENCES assistant_records(id) ON DELETE SET NULL,
  -- Discovery provenance, when there is any. A manually added lead has neither, and that is a real
  -- state rather than a lookup failure.
  discovered_lead_id  integer REFERENCES discovered_leads(id) ON DELETE SET NULL,
  -- Denormalised from the lead deliberately: a future proposer must be able to require that a
  -- cluster spans more than one campaign, and it cannot ask that question through a SET NULL link
  -- that may already be gone.
  campaign_id         integer REFERENCES discovery_campaigns(id) ON DELETE SET NULL,
  reason              text NOT NULL,
  -- Flipped when a change built from this row is applied, so the same rejections cannot fund a
  -- second retargeting. Mirrors template_feedback.applied_to_template.
  applied_to_target   boolean NOT NULL DEFAULT false,
  created_at          timestamp NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_reject_feedback_reason_check') THEN
    ALTER TABLE lead_reject_feedback ADD CONSTRAINT lead_reject_feedback_reason_check
      CHECK (reason IN (
        'competitor','not_a_business','wrong_industry','too_small','too_large',
        'wrong_geography','existing_customer','no_buying_signal','bad_contact','other'));
  END IF;
END $$;

-- The aggregate a proposer would run: unbanked rows for one assistant, grouped by reason, within a
-- recent window. Partial on applied_to_target because banked rows are dead weight to that query.
CREATE INDEX IF NOT EXISTS lead_reject_feedback_assistant_reason_idx
  ON lead_reject_feedback (ai_assistant_id, reason, created_at)
  WHERE applied_to_target = false;

CREATE INDEX IF NOT EXISTS lead_reject_feedback_org_idx
  ON lead_reject_feedback (organisation_id, created_at);

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint WHERE conrelid = 'lead_reject_feedback'::regclass;
--   SELECT indexname FROM pg_indexes WHERE tablename = 'lead_reject_feedback';
--
-- Prove the CHECK both accepts good values and rejects bogus ones without leaving test rows — wrap
-- an INSERT in a transaction that rolls back.
