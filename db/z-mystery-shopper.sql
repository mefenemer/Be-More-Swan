-- db/z-mystery-shopper.sql — the Mystery Shopper's audits, runs and fixes.
-- docs/mystery-shopper-plan.md §5. Code: src/utils/site-audit.ts (pipeline),
-- netlify/functions/site-audits.ts (API), netlify/functions/run-site-audit-background.ts (worker).
-- Drizzle mirror: db/schema.ts (siteAudits, siteAuditRuns, siteAuditFixes).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-mystery-shopper                              (staging)
--   npm run db:migrate:apply -- --only z-mystery-shopper --url-var DATABASE_URL_PROD  (prod)
--
-- ORDER: only the Mystery Shopper reads these tables, and the role is Hidden until go-live, so
-- nothing customer-facing breaks if the code lands first — but its API answers 500 until this exists.
--
-- Shape, and why:
--   site_audits      — ONE per hired Mystery Shopper (unique on the assistant): the site it watches,
--                      who the site is for, what a visitor should do, up to 3 competitors, the scores
--                      it is tracking towards its goal, and the content hashes of the last read.
--   site_audit_runs  — one row per check. `pages` keeps exactly what the lenses were shown, so a
--                      score can always be explained from the row alone. A run that found nothing
--                      changed is still a row (status 'unchanged') — that is the weekly proof the
--                      assistant looked. audit_id is NULL only for the public taster (kind
--                      'public_taster'), which belongs to no workspace.
--   site_audit_fixes — the suggested changes, with their own lifecycle: a fix is VERIFIED by a later
--                      run that no longer finds the old text on the page (verified_run_id), which is
--                      why fixes are not just a JSON array on the run.
--
-- Guard against a double click starting two paid runs: at most ONE queued/running run per audit
-- (partial unique index). `charged` is set in the same UPDATE that finishes the run, so a task is
-- recorded at most once per run.

BEGIN;

CREATE TABLE IF NOT EXISTS site_audits (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id  INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    url              TEXT NOT NULL,
    icp              TEXT,
    conversion_goal  TEXT,
    competitor_urls  JSONB NOT NULL DEFAULT '[]'::jsonb,
    check_weekday    SMALLINT NOT NULL DEFAULT 1 CHECK (check_weekday BETWEEN 0 AND 6),
    baseline_score   INTEGER,
    current_score    INTEGER,
    target_score     INTEGER NOT NULL DEFAULT 85 CHECK (target_score BETWEEN 1 AND 100),
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'goal_met')),
    last_hashes      JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_run_id      INTEGER,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS site_audits_assistant_uq ON site_audits (ai_assistant_id);
CREATE INDEX IF NOT EXISTS site_audits_org_idx ON site_audits (organisation_id);

CREATE TABLE IF NOT EXISTS site_audit_runs (
    id               SERIAL PRIMARY KEY,
    audit_id         INTEGER REFERENCES site_audits(id) ON DELETE CASCADE,
    organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
    requested_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('baseline', 'weekly', 'manual', 'public_taster')),
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'done', 'unchanged', 'unreadable', 'failed')),
    overall_score    INTEGER,
    scores           JSONB,
    pages            JSONB,
    changes          JSONB,
    report           JSONB,
    grounding_dropped INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    charged          BOOLEAN NOT NULL DEFAULT false,
    -- Public taster only: sha256 of the lower-cased email (never the address itself here) and of
    -- the normalised URL, for the per-email limit and the 24h same-URL cache.
    email_hash       TEXT,
    url_hash         TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    started_at       TIMESTAMP,
    finished_at      TIMESTAMP,
    CONSTRAINT site_audit_runs_owner_check CHECK (kind = 'public_taster' OR (audit_id IS NOT NULL AND organisation_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS site_audit_runs_audit_idx ON site_audit_runs (audit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS site_audit_runs_taster_url_idx ON site_audit_runs (url_hash, created_at DESC) WHERE kind = 'public_taster';
CREATE UNIQUE INDEX IF NOT EXISTS site_audit_runs_one_in_flight_uq
    ON site_audit_runs (audit_id) WHERE status IN ('queued', 'running') AND audit_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS site_audit_fixes (
    id               SERIAL PRIMARY KEY,
    audit_id         INTEGER NOT NULL REFERENCES site_audits(id) ON DELETE CASCADE,
    run_id           INTEGER NOT NULL REFERENCES site_audit_runs(id) ON DELETE CASCADE,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    lens             TEXT NOT NULL CHECK (lens IN ('clarity', 'compete', 'ai')),
    location         TEXT,
    problem          TEXT NOT NULL,
    before_text      TEXT NOT NULL,
    after_text       TEXT NOT NULL,
    why_it_matters   TEXT,
    impact           TEXT NOT NULL DEFAULT 'medium' CHECK (impact IN ('high', 'medium', 'low')),
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'done', 'dismissed')),
    verified_run_id  INTEGER REFERENCES site_audit_runs(id) ON DELETE SET NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_audit_fixes_audit_status_idx ON site_audit_fixes (audit_id, status);

COMMIT;
