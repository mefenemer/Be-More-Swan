-- db/z-content-pillars.sql — content pillars as records (docs/pillar-records-plan.md, phase 1).
-- Code: src/utils/content-pillars-store.ts, netlify/functions/content-pillars.ts.
-- Drizzle mirror: db/schema.ts (contentPillars, scheduledPosts.pillarId).
--
-- Each Social Media assistant's pillars become rows. The table is the TRUTH. The names of the active
-- pillars are still written to ai_assistants.onboarding_context.content_pillars (a DERIVED copy), so
-- every reader that only wants names keeps working. Pillars are archived, never deleted, so posts keep
-- their link and the balance counts stay true.
--
-- scheduled_posts.pillar_id links a post to its pillar. Balancing counts by id, so renaming a pillar
-- keeps its history. The text column scheduled_posts.pillar is still written.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-content-pillars.sql                              (staging)
--   npm run db:migrate:apply -- --only z-content-pillars.sql --url-var DATABASE_URL_PROD  (prod)
-- Then run the backfill (scripts/backfill-content-pillars.ts), dry run first.
-- ⚠️ MUST be applied before the code deploys: db/schema.ts now lists scheduled_posts.pillar_id, so every
-- whole-row select of scheduled_posts fails until the column exists. (Pillar reads alone would fall
-- back to onboarding_context.content_pillars, but that does not save the rest.)

BEGIN;

CREATE TABLE IF NOT EXISTS content_pillars (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    assistant_id     INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    description      TEXT,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    archived_at      TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT content_pillars_name_len CHECK (char_length(name) BETWEEN 1 AND 60),
    CONSTRAINT content_pillars_description_len CHECK (description IS NULL OR char_length(description) <= 300)
);
CREATE INDEX IF NOT EXISTS content_pillars_assistant_idx ON content_pillars (assistant_id, sort_order);
-- One live pillar per name (case-insensitive) on an assistant. Archived names can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS content_pillars_live_name_uq
    ON content_pillars (assistant_id, lower(name)) WHERE archived_at IS NULL;

ALTER TABLE scheduled_posts
    ADD COLUMN IF NOT EXISTS pillar_id INTEGER REFERENCES content_pillars(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS scheduled_posts_pillar_id_idx
    ON scheduled_posts (assistant_id, pillar_id) WHERE pillar_id IS NOT NULL;

COMMIT;

-- Check: expect one row, content_pillars, and pillar_id present.
SELECT to_regclass('public.content_pillars') AS table_exists,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'scheduled_posts' AND column_name = 'pillar_id') AS pillar_id_exists;
