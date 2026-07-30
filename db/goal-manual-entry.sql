-- SMART Goals — user-reported (manual) metrics.
--
-- WHY THIS EXISTS: goals could only be set against numbers the platform can measure itself, which
-- left out the numbers most businesses actually care about — revenue, subscription uptake, bookings.
-- Those are now catalog metrics with `source: 'manual'` (src/config/goal-metrics.ts): the user types
-- the figure in on a cadence, exactly as manual_follower_counts already does for LinkedIn.
--
-- Only ONE column is needed. goal_telemetry.source is already free text, so a manual entry is just a
-- row with source='manual', and goals.status is free text so 'awaiting_update' needs no DDL either.
-- What we do not have is WHO typed the number, which matters here in a way it never did for a poll:
-- a manual value is a human assertion, several people in an org can enter one, and a figure that
-- looks wrong six months later is unanswerable without a name against it.
--
-- Idempotent — safe to run more than once.
-- APPLY THIS FILE (Neon SQL editor as the owner) — do NOT use `drizzle-kit push`; RLS policies live
-- in raw SQL and a push can propose dropping them. Canonical column definitions live in db/schema.ts
-- (export const goalTelemetry).

ALTER TABLE goal_telemetry
    ADD COLUMN IF NOT EXISTS entered_by_user_id integer REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN goal_telemetry.entered_by_user_id IS
    'For source=''manual'': the user who typed this figure in. NULL for polled/rollup rows.';

-- The Goals tab reads "your last entry" on every render, per goal. Without this the lookup is a
-- filtered scan of the whole time series for goals that may have hundreds of polled rows alongside
-- a handful of manual ones.
CREATE INDEX IF NOT EXISTS goal_telemetry_manual_idx
    ON goal_telemetry (goal_id, recorded_at DESC)
    WHERE source = 'manual';
