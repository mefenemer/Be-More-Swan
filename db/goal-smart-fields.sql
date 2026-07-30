-- SMART Goals — the "S" (Specific). Adds the two user-authored text fields that turn a goal from
-- a bare `metric + number + date` into something a human (and the generation prompt) can read.
--
-- WHY THIS EXISTS: goals were measurable (M), attainable (A), relevant (R) and time-bound (T), but
-- nothing captured WHAT the user is actually trying to do or WHY it matters. That rationale is the
-- single most useful thing to hand the content model — "grow to 20,000 followers" steers nothing,
-- "grow to 20,000 followers because we're launching a wholesale line in Q4 and need retail buyers
-- to find us" steers topic, format and CTA. Both columns are nullable so every existing goal row
-- stays valid; the blueprint simply omits an absent rationale.
--
-- APPLY THIS FILE manually (Neon SQL editor as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can propose
-- DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled tables.
-- Canonical column definitions live in db/schema.ts (export const goals).
-- Idempotent — safe to run more than once.

ALTER TABLE goals
    ADD COLUMN IF NOT EXISTS title      text,   -- short user-authored name, e.g. "Reach wholesale buyers"
    ADD COLUMN IF NOT EXISTS rationale  text;   -- the "why" — free text, injected into the brief

COMMENT ON COLUMN goals.title IS
    'Short user-authored goal name shown in the Goals tab and the blueprint (SMART: Specific).';
COMMENT ON COLUMN goals.rationale IS
    'User-authored reason the goal matters. Injected into the content-generation prompt to steer topic/format/CTA.';
