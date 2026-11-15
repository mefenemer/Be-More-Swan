-- db/z-trigger-events.sql — Buying triggers Phase 1 (docs/buying-triggers-plan.md §3, §5, FR#36):
-- the trigger engine's tables, fed first by the FSA food hygiene ratings list (new food and drink
-- premises "Awaiting Inspection"). ADMIN ONLY in this phase: nothing here reaches a customer.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and
-- prod separately), BEFORE or AFTER the code deploys — Admin ▸ Assistants ▸ Buying triggers says
-- "not set up yet" and the daily poll does nothing until this runs. Idempotent: CREATE … IF NOT
-- EXISTS only. Nothing is dropped or altered. No DO blocks and no semicolons inside quoted text, so
-- the Neon editor's statement splitter cannot cut a statement in half.
--
-- Three tables:
--   trigger_sources — one row per feed (fsa_fhrs): kill switch state, whether the silent first look
--                     (the baseline) has finished, and the last run's counts.
--   trigger_seen    — every subject a feed currently lists (for the FSA: every premises awaiting
--                     inspection), so tomorrow's list can be diffed against today's. Rows not seen for
--                     30 days are deleted (the premises was inspected).
--   trigger_events  — one row per trigger: something happened to a business on a given day. Kept 90
--                     days while no workspace uses it (no workspace does in Phase 1).

BEGIN;

CREATE TABLE IF NOT EXISTS trigger_sources (
    source            TEXT PRIMARY KEY,
    baseline_done_at  TIMESTAMPTZ,
    last_run_at       TIMESTAMPTZ,
    last_ok_at        TIMESTAMPTZ,
    last_result       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trigger_seen (
    source         TEXT NOT NULL,
    subject_id     TEXT NOT NULL,
    -- true = it was already listed during the silent first look, so it never became an event.
    baseline       BOOLEAN NOT NULL DEFAULT false,
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, subject_id)
);

CREATE INDEX IF NOT EXISTS trigger_seen_last_seen_idx ON trigger_seen (source, last_seen_at);

CREATE TABLE IF NOT EXISTS trigger_events (
    id                  BIGSERIAL PRIMARY KEY,
    -- 'food_premises_registered' (more kinds in later phases)
    kind                TEXT NOT NULL,
    -- 'fsa_fhrs'
    source              TEXT NOT NULL,
    source_event_id     TEXT NOT NULL,
    country             TEXT NOT NULL DEFAULT 'GB',
    -- 'ch_number' | 'fhrs_id' | 'domain' | 'place_id' | 'us_entity'
    subject_type        TEXT NOT NULL,
    subject_id          TEXT NOT NULL,
    name                TEXT,
    postcode            TEXT,
    -- For the FSA: the council (local authority) name.
    area                TEXT,
    trade_codes         TEXT[] NOT NULL DEFAULT '{}',
    occurred_on         DATE NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The Companies House match (name + postcode, or the only active company of that name).
    -- company_checked_at NULL = not looked up yet. A miss leaves company_number NULL.
    company_number      TEXT,
    company_type        TEXT,
    company_matched_by  TEXT,
    company_checked_at  TIMESTAMPTZ,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_event_id)
);

CREATE INDEX IF NOT EXISTS trigger_events_first_seen_idx ON trigger_events (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS trigger_events_area_idx ON trigger_events (area);
CREATE INDEX IF NOT EXISTS trigger_events_unchecked_idx ON trigger_events (first_seen_at) WHERE company_checked_at IS NULL;

COMMIT;
