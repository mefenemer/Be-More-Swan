-- db/z-mystery-shopper-check-work.sql — "I'll work on this" on the Mystery Shopper's "Why your score isn't higher".
-- Code: src/utils/site-audit-check-work.ts, netlify/functions/site-audits.ts (action `check_work`),
-- src/utils/site-audit.ts (a later check confirms), src/components/assistant-site-audit.js.
-- Drizzle mirror: db/schema.ts (siteAuditCheckWork).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-mystery-shopper-check-work                              (staging)
--   npm run db:migrate:apply -- --only z-mystery-shopper-check-work --url-var DATABASE_URL_PROD  (prod)
--
-- ORDER: before the code is best, but not required — `get` reads this table inside a try/catch and
-- the tab hides the button until it exists.
--
-- Why a table: the list is worked out afresh from each run's scores JSON, which is the record of what
-- the check found and is never edited; this is the record of what the user said they'd do about it.
-- site_audit_fixes can't hold these: a fix is verified by finding its old TEXT gone, and a failed check
-- often has no text at all ("no FAQ section"). These are verified by the check itself passing.
--
--   status 'accepted'                 — they said they'd work on it (In progress)
--   status 'done', verified_run_id    — a later check passed it (Done)
--   status 'done', no verified_run_id — they said they'd done it; the next check that passes it confirms
-- Undo deletes the row. label/lens/weight are copied at the time, so Done reads the same later.

BEGIN;

CREATE TABLE IF NOT EXISTS site_audit_check_work (
    id               SERIAL PRIMARY KEY,
    audit_id         INTEGER NOT NULL REFERENCES site_audits(id) ON DELETE CASCADE,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    page_url         TEXT NOT NULL,
    check_id         TEXT NOT NULL,
    lens             TEXT NOT NULL CHECK (lens IN ('clarity', 'compete', 'ai')),
    weight           SMALLINT NOT NULL,
    label            TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('accepted', 'done')),
    verified_run_id  INTEGER REFERENCES site_audit_runs(id) ON DELETE SET NULL,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS site_audit_check_work_uq ON site_audit_check_work (audit_id, page_url, check_id);

COMMIT;

-- "Check if this is done" on anything in In progress, and the loop through the Website Assistant.
-- One row per item (a fix, or a site_audit_check_work row): run_id is the check last asked for, and the
-- verdict is read from that run plus the item's own status, so a run that fails or is swept can't
-- leave an item stuck on "checking". website_asked_at: they asked the Website Assistant to make this
-- change, and the next Publish of that site starts a recheck (site-audit-recheck.ts), then clears it.

BEGIN;

CREATE TABLE IF NOT EXISTS site_audit_item_checks (
    id                SERIAL PRIMARY KEY,
    audit_id          INTEGER NOT NULL REFERENCES site_audits(id) ON DELETE CASCADE,
    organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    item_kind         TEXT NOT NULL CHECK (item_kind IN ('fix', 'check')),
    item_id           INTEGER NOT NULL,
    run_id            INTEGER REFERENCES site_audit_runs(id) ON DELETE SET NULL,
    website_asked_at  TIMESTAMP,
    created_at        TIMESTAMP NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS site_audit_item_checks_uq ON site_audit_item_checks (audit_id, item_kind, item_id);

COMMIT;
