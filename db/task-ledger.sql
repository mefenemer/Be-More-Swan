-- db/task-ledger.sql
-- One task allowance (docs/task-metering.md): an itemised record of what every task paid for, and
-- a non-expiring bonus-task balance.
--
-- task_ledger — append-only. One row per charge (source 'work') and per bonus grant ('conversion',
--   'admin', 'purchase'). usage_counters.task_count stays the fast counter the cap check reads; this
--   is the breakdown behind it (Billing page by kind and by assistant) and what reconcile-billing
--   checks the counter against. bonus_units = how much of a work charge came out of bonus tasks.
--
-- task_bonus — one row per org. Bonus tasks never expire and are spent only once the monthly
--   allowance is used up; the spend is taken at the moment the work is recorded
--   (src/utils/work-metering.ts), so there is no month-end settlement.
--
-- Idempotent; additive only. Apply manually as the DB owner (staging, then prod).

CREATE TABLE IF NOT EXISTS task_ledger (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  period_start     TIMESTAMP NOT NULL,                 -- same value as usage_counters.period_start
  kind             TEXT NOT NULL,                      -- a WorkKind (src/config/task-weights.ts) or 'bonus_grant'
  units            INTEGER NOT NULL,                   -- tasks charged (work) or bonus tasks granted (+/-)
  bonus_units      INTEGER NOT NULL DEFAULT 0,         -- part of a work charge paid from bonus tasks
  source           TEXT NOT NULL DEFAULT 'work',
  assistant_id     INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- actor for admin grants
  ref              TEXT,                               -- job / post / issue id the charge belongs to
  note             TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT task_ledger_source_check CHECK (source IN ('work', 'conversion', 'admin', 'purchase')),
  CONSTRAINT task_ledger_bonus_units_check CHECK (bonus_units >= 0 AND bonus_units <= GREATEST(units, 0))
);

CREATE INDEX IF NOT EXISTS task_ledger_org_period_idx ON task_ledger (organisation_id, period_start);
CREATE INDEX IF NOT EXISTS task_ledger_assistant_idx  ON task_ledger (organisation_id, assistant_id, period_start);

-- A conversion row is written once per org; the unique index is what makes the cutover script
-- (db/z-task-credit-conversion.sql) safe to re-run.
CREATE UNIQUE INDEX IF NOT EXISTS task_ledger_one_conversion_idx
  ON task_ledger (organisation_id) WHERE source = 'conversion';

CREATE TABLE IF NOT EXISTS task_bonus (
  organisation_id  INTEGER PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  bonus_tasks      INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT task_bonus_nonneg CHECK (bonus_tasks >= 0)
);

-- The rollout switch (src/utils/task-metering-flag.ts). Created OFF: whitelist test workspaces via
-- allowed_workspace_ids; db/ops/task-allowance-cutover.sql turns it on for everyone on 1 Dec 2026.
INSERT INTO feature_flags (key, enabled, rollout_percentage, description)
VALUES ('unified_task_metering', false, 0,
        'Single task allowance: chat and helpers free (fair use); AI media and X link posts spend weighted tasks; credits retired. docs/task-metering.md')
ON CONFLICT (key) DO NOTHING;
