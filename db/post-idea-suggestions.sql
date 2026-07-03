-- "Create Post" → Suggest an idea mode.
--
-- A user-submitted post idea (suggest-post-idea.ts) that the assistant should weave into a FUTURE
-- scheduled/conversion draft — it is NOT drafted immediately. Consumed once, FIFO: when
-- process-content-jobs.ts picks up a scheduled/conversion job that carries no context_prompt, it
-- pulls the oldest 'pending' idea for that assistant, uses the idea text as the generation context,
-- and on success links + marks the row 'in_review' (used_post_id = the resulting draft, used_at).
--
-- Idea lifecycle (surfaced in the Review Queue → Ideas tab so the user can track each one):
--   pending     → submitted, not yet woven into a draft
--   in_review   → woven into a draft that is now awaiting human review (used_post_id linked)
--   delivered   → that draft was approved (approve-post.ts sets delivered_at); loop closed
--   discarded   → dropped (e.g. its draft was rejected and the idea wasn't reused)
--   used        → legacy synonym for in_review (older rows; migrated below)
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled tables.
-- Canonical column definitions live in db/schema.ts (export const postIdeaSuggestions).
-- Idempotent — safe to re-run.
--
-- RLS: intentionally NOT enabled here. Reads/writes go through getDb() (the neondb_owner
-- connection, which bypasses RLS) and filter by organisation_id explicitly — the same
-- owner-path + manual-filter pattern as content_rules / scheduled_posts / post_insights.

CREATE TABLE IF NOT EXISTS post_idea_suggestions (
  id              SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assistant_id    INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea            TEXT NOT NULL,
  platform        TEXT,                              -- optional hint: facebook|instagram|linkedin|x
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | in_review | delivered | used(legacy) | discarded
  used_post_id    INTEGER REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  used_at         TIMESTAMP,
  delivered_at    TIMESTAMP                           -- set when used_post_id was approved
);

-- For tables created before this column existed (idempotent).
ALTER TABLE post_idea_suggestions ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;

-- FIFO lookup of the next pending idea for an assistant.
CREATE INDEX IF NOT EXISTS post_idea_suggestions_assistant_status_idx
  ON post_idea_suggestions (assistant_id, status);

-- Reverse lookup (post → originating idea) used by approve-post.ts and get-social-drafts.ts.
CREATE INDEX IF NOT EXISTS post_idea_suggestions_used_post_idx
  ON post_idea_suggestions (used_post_id);

-- Constrain status to the known lifecycle values. Drop-then-add so re-running widens an older
-- constraint that predates the in_review/delivered states. Migrate legacy 'used' rows first so the
-- new (stricter-named) lifecycle is consistent — 'used' stays permitted for safety.
UPDATE post_idea_suggestions SET status = 'in_review' WHERE status = 'used';

ALTER TABLE post_idea_suggestions DROP CONSTRAINT IF EXISTS post_idea_suggestions_status_check;
ALTER TABLE post_idea_suggestions
  ADD CONSTRAINT post_idea_suggestions_status_check
  CHECK (status IN ('pending', 'in_review', 'delivered', 'used', 'discarded'));
