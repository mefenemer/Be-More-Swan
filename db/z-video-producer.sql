-- db/z-video-producer.sql — the Video Producer, Phase 5 (storyboard + assembly).
-- Plan: docs/video-producer-plan.md §5.3–5.8. Code: src/lib/storyboard.ts, src/utils/video-producer.ts,
-- netlify/functions/video-projects.ts, netlify/functions/process-video-project-background.ts.
-- Drizzle mirror: db/schema.ts (videoProjects).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-video-producer                              (staging)
--   npm run db:migrate:apply -- --only z-video-producer --url-var DATABASE_URL_PROD  (prod)
--
-- One new table; nothing existing is altered. No catalogue row yet — the role itself is Phase 6.
--
-- ── video_projects ──────────────────────────────────────────────────────────
-- One video from brief to finished post:
--   draft → planning → planned (the owner reviews the storyboard) → building → built
--                                                                            ↘ failed / cancelled
-- The storyboard is the model's plan AFTER src/lib/storyboard.ts enforced the rules; `changes` lists
-- what the rules altered, so the review panel can say so. `scene_assets` records what each scene was
-- sourced as (asset id per scene id), so a re-build re-sources only the scenes that changed and a
-- failure part-way keeps what was already paid for.
-- The finished video is an ordinary scheduled_posts row (one per platform, sharing a cross-post group)
-- with a video_edit — it reviews, renders and publishes like every other post.

BEGIN;

CREATE TABLE IF NOT EXISTS video_projects (
    id                SERIAL PRIMARY KEY,
    organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id   INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,
    created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title             TEXT NOT NULL DEFAULT 'New video',
    status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'planning', 'planned', 'building', 'built', 'failed', 'cancelled')),
    brief             JSONB NOT NULL,
    storyboard        JSONB,
    changes           JSONB NOT NULL DEFAULT '[]'::jsonb,
    scene_assets      JSONB NOT NULL DEFAULT '{}'::jsonb,
    voiceover_asset_id INTEGER REFERENCES content_assets(id) ON DELETE SET NULL,
    scheduled_post_id INTEGER REFERENCES scheduled_posts(id) ON DELETE SET NULL,
    crosspost_group_id TEXT,
    -- Credits held by the build in flight; settled and zeroed in ONE update, so only once.
    credit_hold       INTEGER NOT NULL DEFAULT 0,
    credits_spent     INTEGER NOT NULL DEFAULT 0,
    -- Why the last step stopped short, in words the owner can act on. NULL when it did not.
    note              TEXT,
    started_at        TIMESTAMP,
    created_at        TIMESTAMP NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_projects_org_status_idx ON video_projects (organisation_id, status);

-- No RLS, like visual_briefs: every read and write is scoped by organisation_id in code.

COMMIT;
