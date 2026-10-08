-- db/z-brand-designer.sql — the Brand Designer (roleKey `brand_designer`), Phase 1.
-- Plan: docs/brand-designer-plan.md §4. Code: src/utils/visual-briefs.ts, netlify/functions/brand-briefs.ts,
-- netlify/functions/generate-brief-options-background.ts. Drizzle mirror: db/schema.ts (visualBriefs,
-- visualBriefOptions).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-brand-designer                              (staging)
--   npm run db:migrate:apply -- --only z-brand-designer --url-var DATABASE_URL_PROD  (prod)
--
-- New tables, one catalogue row and one feature grant — nothing existing is altered.
--
-- ── visual_briefs ───────────────────────────────────────────────────────────
-- What a picture is FOR: the message, the mood, what must and must not be in it, the format, and
-- which sources may answer it. One brief → rounds of options → the user approves one or more.
--
-- ── visual_brief_options ────────────────────────────────────────────────────
-- The candidates a round produced. Deliberately NOT content_assets rows: the library (My Content)
-- lists every content_assets row in the workspace, so twelve unreviewed candidates per brief would
-- bury the user's real pictures. An option becomes a content_assets row only when APPROVED.
--   • ai_image / brand_card options hold an R2 key (fal URLs expire within hours; a card is bytes we
--     drew) — the approved asset points at the same key, so nothing is copied twice.
--   • stock options hold the Pexels CDN URL and attribution, never our own copy (Pexels terms —
--     see src/utils/pexels.ts).
--
-- ── The catalogue row ───────────────────────────────────────────────────────
-- Inserted HERE rather than left to db/seed-catalog.ts, because running the seed is how plan
-- features were overwritten before (seed-overwrites-plan-features). ON CONFLICT DO NOTHING: once the
-- row exists every field is the admin's (Admin → Master Data → Assistants), including coming_soon —
-- go-live is an admin flip, not a re-run of this file.
--
-- ── The AI image grant ──────────────────────────────────────────────────────
-- generate-ai-image and this assistant's AI source are gated on the `ai_image_generation` feature
-- of an active assistant TYPE. Without this row a workspace whose only image-capable hire is the
-- Brand Designer would be refused AI images by the very assistant whose job they are. Image only:
-- AI video is Phase 4 and the grant is ORG-WIDE (assistant-features.sql), so it is not handed out
-- before this role can use it.

BEGIN;

CREATE TABLE IF NOT EXISTS visual_briefs (
    id                    SERIAL PRIMARY KEY,
    organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id       INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title                 TEXT NOT NULL,
    purpose               TEXT NOT NULL DEFAULT 'social_post'
                          CHECK (purpose IN ('social_post', 'blog_header', 'ad', 'email_header', 'story', 'other')),
    aspect_ratio          TEXT NOT NULL DEFAULT '1:1' CHECK (aspect_ratio IN ('1:1', '4:5', '16:9', '9:16')),
    media_type            TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
    message               TEXT,
    headline              TEXT,
    mood                  TEXT,
    must_include          TEXT,
    must_avoid            TEXT,
    sources               JSONB NOT NULL DEFAULT '["stock","ai_image","brand_card"]'::jsonb,
    status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'generating', 'in_review', 'approved', 'cancelled')),
    origin                TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'chat')),
    due_date              DATE,
    rounds                INTEGER NOT NULL DEFAULT 0,
    -- What the designer derived from the brief for the latest round (image prompt, stock keywords,
    -- card headline) — shown to the user so a disappointing round can be understood, not guessed at.
    art_direction         JSONB,
    -- Credits held by the round in flight. Settled (charged or refunded) by whoever ends the round —
    -- the worker, or the timeout sweep in brand-briefs.ts — and zeroed in the same UPDATE, so a
    -- hold can only ever be settled once.
    credit_hold           INTEGER NOT NULL DEFAULT 0,
    generation_started_at TIMESTAMP,
    -- Why the last round produced less than asked (a source unavailable, a provider refusal).
    -- Shown on the brief; NULL when the round was complete.
    generation_note       TEXT,
    created_at            TIMESTAMP NOT NULL DEFAULT now(),
    updated_at            TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visual_briefs_assistant_status_idx
    ON visual_briefs (organisation_id, ai_assistant_id, status);

CREATE TABLE IF NOT EXISTS visual_brief_options (
    id                 SERIAL PRIMARY KEY,
    organisation_id    INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    brief_id           INTEGER NOT NULL REFERENCES visual_briefs(id) ON DELETE CASCADE,
    round              INTEGER NOT NULL,
    source             TEXT NOT NULL CHECK (source IN ('stock', 'ai_image', 'brand_card')),
    status             TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
    storage_key        TEXT,
    external_url       TEXT,
    mime_type          TEXT,
    width              INTEGER,
    height             INTEGER,
    -- What produced it: the AI prompt, the card headline, or the stock search words.
    prompt             TEXT,
    provider_asset_id  TEXT,
    attribution_name   TEXT,
    attribution_url    TEXT,
    render_params      JSONB,
    reject_reason      TEXT,
    content_asset_id   INTEGER REFERENCES content_assets(id) ON DELETE SET NULL,
    decided_at         TIMESTAMP,
    created_at         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visual_brief_options_brief_idx ON visual_brief_options (brief_id, round);

INSERT INTO master_assistants
    (role_key, name, description, category, icon_key, icon_color, tagline, key_features, integrations, works_with, coming_soon, is_active)
VALUES (
    'brand_designer',
    'Brand Designer',
    'Turns a brief into on-brand pictures — stock photos, AI images and branded cards made from your colours, font and logo — and puts the options in front of you to approve. Nothing you approve needs Canva; anything you approve lands in your library for every assistant to use.',
    'Marketing & Sales',
    'lightning',
    'pink',
    'Say what the picture is for. Approve the one that fits.',
    '["Briefs, Not Prompts","Stock, AI and Branded Cards Side by Side","Nothing Is Used Until You Approve It"]'::jsonb,
    '[]'::jsonb,
    '["standalone"]'::jsonb,
    true,
    true
)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO assistant_features (master_assistant_id, feature_key, enabled)
SELECT ma.id, 'ai_image_generation', true
  FROM master_assistants ma
 WHERE ma.role_key = 'brand_designer'
ON CONFLICT (master_assistant_id, feature_key) DO NOTHING;

COMMIT;
