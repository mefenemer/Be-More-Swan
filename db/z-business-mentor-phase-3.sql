-- db/z-business-mentor-phase-3.sql — the Business Mentor, Phase 3: the weekly review.
-- Plan: docs/business-mentor-plan.md §5 (§5.1 commitments, §5.2 customers, §5.3 track record).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and
-- prod separately). Idempotent: safe to re-run (CREATE … IF NOT EXISTS only; nothing is dropped). The
-- code tolerates all three tables being missing: the Overview says "not switched on yet", the weekly
-- review is skipped, and "Review my week now" refuses with a plain message.
--
-- Three tables:
--   1. mentor_reviews     — one row per weekly review (scheduled, or "Review my week now"): what it
--                           said, which suggestions it made. The Reviews list on the Mentor's page.
--   2. mentor_commitments — the 1–3 things a person will do this week (§5.1), each with an owner, and
--                           why a missed one was missed (a closed list).
--   3. mentor_outcomes    — every accepted Mentor suggestion, the measure it was meant to move, its
--                           value then and later (§5.3: "since", never "because"). Also links a draft
--                           the Mentor asked for, for its "Requested by" pill.

BEGIN;

CREATE TABLE IF NOT EXISTS mentor_reviews (
  id               serial PRIMARY KEY,
  organisation_id  integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id  integer REFERENCES ai_assistants(id) ON DELETE SET NULL,
  requested_by     integer REFERENCES users(id) ON DELETE SET NULL,
  trigger          text NOT NULL DEFAULT 'schedule',
  -- Monday of the review's week, UK time.
  week_start       date NOT NULL,
  status           text NOT NULL DEFAULT 'queued',
  outcome          text,
  summary          text,
  -- { "sections": [{ "title", "text" }], "figures": [...], "proposals": [{ "id", "type", "title", "target" }] }
  body             jsonb,
  proposal_ids     integer[] NOT NULL DEFAULT '{}'::integer[],
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  CONSTRAINT mentor_reviews_trigger_check CHECK (trigger IN ('schedule', 'on_demand')),
  CONSTRAINT mentor_reviews_status_check CHECK (status IN ('queued', 'running', 'done', 'failed')),
  CONSTRAINT mentor_reviews_outcome_check CHECK (outcome IS NULL OR outcome IN ('reviewed', 'not_enough_data'))
);

CREATE INDEX IF NOT EXISTS mentor_reviews_org_created_idx ON mentor_reviews (organisation_id, created_at DESC);
-- The schedule queues at most one review per workspace per week; "Review my week now" isn't limited by this.
CREATE UNIQUE INDEX IF NOT EXISTS mentor_reviews_one_scheduled_idx
  ON mentor_reviews (organisation_id, week_start) WHERE trigger = 'schedule';

CREATE TABLE IF NOT EXISTS mentor_commitments (
  id               serial PRIMARY KEY,
  organisation_id  integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  owner_user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start       date NOT NULL,
  text             text NOT NULL,
  status           text NOT NULL DEFAULT 'open',
  miss_reason      text,
  note             text,
  created_by       integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  closed_by        integer REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT mentor_commitments_status_check CHECK (status IN ('open', 'done', 'missed', 'dropped')),
  CONSTRAINT mentor_commitments_miss_reason_check CHECK (miss_reason IS NULL OR miss_reason IN
    ('no_time', 'didnt_know_how', 'priorities_changed', 'waiting_on_someone', 'decided_against', 'other'))
);

CREATE INDEX IF NOT EXISTS mentor_commitments_org_week_idx ON mentor_commitments (organisation_id, week_start DESC);

CREATE TABLE IF NOT EXISTS mentor_outcomes (
  id                   serial PRIMARY KEY,
  organisation_id      integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  proposal_id          integer NOT NULL REFERENCES mentor_proposals(id) ON DELETE CASCADE,
  target_assistant_id  integer REFERENCES ai_assistants(id) ON DELETE SET NULL,
  kind                 text NOT NULL,
  change               text NOT NULL,
  measure_key          text,
  measure_label        text,
  before_value         numeric,
  after_value          numeric,
  job_id               text,
  accepted_at          timestamptz NOT NULL DEFAULT now(),
  checked_at           timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS mentor_outcomes_proposal_uidx ON mentor_outcomes (proposal_id);
CREATE INDEX IF NOT EXISTS mentor_outcomes_org_idx ON mentor_outcomes (organisation_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS mentor_outcomes_job_idx ON mentor_outcomes (job_id) WHERE job_id IS NOT NULL;

COMMIT;

-- Check it landed (should return 3 rows):
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('mentor_reviews', 'mentor_commitments', 'mentor_outcomes');
