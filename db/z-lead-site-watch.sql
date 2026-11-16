-- db/z-lead-site-watch.sql — Why now Phase 2, website and US part (docs/lead-why-now-and-watching-plan.md
-- §2.2): the Watch list (db/z-lead-watch.sql, buying triggers Phase 2) checks Companies House; this adds
-- the checks that need no register match — the lead's own team page and careers page / job board, and
-- SEC Form D for US leads. Code: src/utils/lead-site-watch.ts, run in the Watch list's daily run
-- (run-lead-watch-background.ts), same switch (lead_watch_settings), same daily note, same tab.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and prod
-- separately), BEFORE OR AFTER the code deploys: until it runs, the website/US checks are skipped and the
-- Companies House Watch list works exactly as before. Idempotent: CREATE … IF NOT EXISTS only. Nothing is
-- dropped or altered. No DO blocks and no semicolons inside quoted text, so the Neon editor's splitter
-- cannot cut a statement in half.
--
-- Two tables:
--   lead_site_watch          one row per watched lead (keyed by the lead): when it is next due, and what
--                            each source looked like last time, so the next look can tell what CHANGED.
--                            The first look at a source only records this; it never reports news.
--   lead_site_watch_signals  one row per thing that happened, unique per lead and ref, so a job or a person
--                            is never reported twice.

BEGIN;

CREATE TABLE IF NOT EXISTS lead_site_watch (
    assistant_record_id  INTEGER PRIMARY KEY REFERENCES assistant_records(id) ON DELETE CASCADE,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id      INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    domain               TEXT NOT NULL,
    -- 'gb' | 'us' | other ISO code | NULL when nothing settles it (Companies House match, search, web address).
    country              TEXT,
    -- US only: the SEC filer, set only when the name AND a state on the lead's own site match.
    sec_cik              TEXT,
    sec_link_tried_at    TIMESTAMPTZ,
    sec_last_accession   TEXT,
    -- Senior people last seen on the team page. NULL = never read (first look is silent).
    team_names           JSONB,
    -- 'page' | 'greenhouse' | 'lever' | 'ashby' | 'workable'
    careers_source       TEXT,
    -- Fingerprint of the job titles, or 'none' when we looked and there is no careers page. NULL = never read.
    careers_hash         TEXT,
    careers_titles       JSONB,
    checks_done          INTEGER NOT NULL DEFAULT 0,
    next_check_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at      TIMESTAMPTZ,
    last_error           TEXT,
    -- Set = not checked ('lead_excluded', 'watching_off').
    paused_reason        TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_site_watch_due_idx ON lead_site_watch (next_check_at) WHERE paused_reason IS NULL;
CREATE INDEX IF NOT EXISTS lead_site_watch_assistant_idx ON lead_site_watch (ai_assistant_id);

CREATE TABLE IF NOT EXISTS lead_site_watch_signals (
    id                   BIGSERIAL PRIMARY KEY,
    assistant_record_id  INTEGER NOT NULL REFERENCES assistant_records(id) ON DELETE CASCADE,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id      INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    -- new_team_member | new_job | careers_page | raised_money | fundraising_update | sec_event
    kind                 TEXT NOT NULL,
    text                 TEXT NOT NULL,
    -- positive | neutral | negative
    direction            TEXT NOT NULL,
    occurred_on          DATE NOT NULL,
    -- 'team:<name>', 'job:<title>', 'careers:started', 'sec:<accession>'
    ref                  TEXT NOT NULL,
    url                  TEXT,
    -- 'team_page' | 'careers' | 'sec'
    source               TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set once the daily roll-up has told the workspace about it.
    notified_at          TIMESTAMPTZ,
    UNIQUE (assistant_record_id, ref)
);

CREATE INDEX IF NOT EXISTS lead_site_watch_signals_assistant_idx ON lead_site_watch_signals (ai_assistant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_site_watch_signals_unnotified_idx ON lead_site_watch_signals (created_at) WHERE notified_at IS NULL;

COMMIT;

-- Verify:
--   SELECT count(*) FROM lead_site_watch;
--   SELECT count(*) FROM lead_site_watch_signals;
