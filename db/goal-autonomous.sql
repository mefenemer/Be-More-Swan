-- SMART Goals US3.3 — Autonomous Optimization Mode.
-- Per-assistant opt-in: when ON, the autonomous-goal-optimizer cron may rewrite a small set of
-- allowed brief params (tone / posting frequency) if one of the assistant's goals goes off_track.
-- Premium-tier gated in the API. Idempotent — safe to run more than once.
--
-- APPLY THIS FILE manually (Neon SQL editor / psql as owner) — do NOT use `drizzle-kit push`.
-- Canonical column definition lives in db/schema.ts (aiAssistants.autonomousGoalSeeking).

ALTER TABLE ai_assistants
    ADD COLUMN IF NOT EXISTS autonomous_goal_seeking boolean NOT NULL DEFAULT false;
