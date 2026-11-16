-- db/z-lead-watch.sql — Buying triggers Phase 2 (docs/buying-triggers-plan.md §3, §5, FR#36): the Lead
-- Generator's Watch list. Companies a workspace watches on Companies House (its leads, its customers and
-- companies it adds by hand), and the signals found on them ("appointed a new director", "new owner or
-- controller", "moved registered office", "registered a new charge", "in liquidation").
-- Code: src/utils/lead-watch.ts (sync, check, signals), src/lib/triggers/ch-watch.ts (fixed wording),
-- netlify/functions/lead-watch.ts (Watch list tab + chat), run-lead-watch-background.ts (the daily
-- check), run-ch-stream-background.ts (the Companies House stream, only with COMPANIES_HOUSE_STREAM_KEY).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and prod
-- separately), BEFORE OR AFTER the code deploys: until it runs, the Watch list tab says "not set up yet"
-- and the daily check does nothing. Idempotent: CREATE … IF NOT EXISTS only. Nothing is dropped or
-- altered. No DO blocks and no semicolons inside quoted text, so the Neon editor's splitter cannot cut a
-- statement in half.
--
-- Three tables:
--   lead_watch_settings one row per assistant that has changed its "Watch list" switch. No row = ON
--                       (why-now decision 1). Its own table because ai_assistants.configuration is
--                       replaced whole by update-assistant-context.ts and would drop the switch.
--   lead_watch          one row per watched company per assistant. A lead's row goes when the lead is
--                       deleted (ON DELETE CASCADE from assistant_records). A company added by hand has
--                       no lead (assistant_record_id NULL).
--   lead_watch_signals  one row per thing that happened, unique per watched company and filing, so the
--                       daily check and the stream can never record the same filing twice.

BEGIN;

CREATE TABLE IF NOT EXISTS lead_watch (
    id                   BIGSERIAL PRIMARY KEY,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id      INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    assistant_record_id  INTEGER REFERENCES assistant_records(id) ON DELETE CASCADE,
    -- 'lead' (a saved lead with a Companies House match) | 'customer' (a lead marked won) | 'manual'
    watch_kind           TEXT NOT NULL CHECK (watch_kind IN ('lead', 'customer', 'manual')),
    company_name         TEXT,
    country              TEXT NOT NULL DEFAULT 'gb',
    ch_number            TEXT NOT NULL,
    -- Later sources (plan Phase 3 / 6). Unused in Phase 2.
    fhrs_id              TEXT,
    place_id             TEXT,
    -- The newest filing seen. NULL = never checked: the first check records it silently.
    ch_last_filing_id    TEXT,
    -- The register status last seen. NULL = never checked.
    ch_status            TEXT,
    checks_done          INTEGER NOT NULL DEFAULT 0,
    next_check_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at      TIMESTAMPTZ,
    last_error           TEXT,
    -- Set = not checked (e.g. 'lead_excluded' when the lead was rejected or marked do-not-contact).
    paused_reason        TEXT,
    added_by_user_id     INTEGER,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ai_assistant_id, ch_number)
);

CREATE INDEX IF NOT EXISTS lead_watch_due_idx ON lead_watch (next_check_at) WHERE paused_reason IS NULL;
CREATE INDEX IF NOT EXISTS lead_watch_ch_number_idx ON lead_watch (ch_number) WHERE paused_reason IS NULL;
CREATE INDEX IF NOT EXISTS lead_watch_record_idx ON lead_watch (assistant_record_id);
CREATE INDEX IF NOT EXISTS lead_watch_org_idx ON lead_watch (organisation_id);

CREATE TABLE IF NOT EXISTS lead_watch_signals (
    id                   BIGSERIAL PRIMARY KEY,
    watch_id             BIGINT NOT NULL REFERENCES lead_watch(id) ON DELETE CASCADE,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id      INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    -- director_appointed | director_left | office_moved | charge_registered | owner_added | owner_left | company_closing
    kind                 TEXT NOT NULL,
    text                 TEXT NOT NULL,
    -- positive | neutral | negative
    direction            TEXT NOT NULL,
    occurred_on          DATE NOT NULL,
    -- The filing's transaction id, or 'status:<status>'.
    ref                  TEXT NOT NULL,
    url                  TEXT,
    -- 'ch_check' (daily per-company check) | 'ch_stream' (the Companies House stream)
    source               TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set once the daily roll-up has told the workspace about it.
    notified_at          TIMESTAMPTZ,
    UNIQUE (watch_id, ref)
);

CREATE INDEX IF NOT EXISTS lead_watch_signals_assistant_idx ON lead_watch_signals (ai_assistant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_watch_signals_unnotified_idx ON lead_watch_signals (created_at) WHERE notified_at IS NULL;

CREATE TABLE IF NOT EXISTS lead_watch_settings (
    ai_assistant_id      INTEGER PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    enabled              BOOLEAN NOT NULL DEFAULT true,
    updated_by_user_id   INTEGER,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
