-- Per-assistant feature capabilities — admin-managed checklist of which features each
-- assistant TYPE (master_assistants catalog row) exposes to customers.
--
-- One row per (master_assistant, feature_key). An absent row means the feature is disabled
-- (default off). The admin "Assistant Features" page toggles these; user-facing gates
-- (e.g. AI image/video generation in My Content) check them via
-- src/utils/assistant-capabilities.ts. The canonical list of feature keys/labels lives in
-- src/config/assistant-features.ts.
--
-- Owner-path config table (like content_rules / goals) — no RLS; queried on the owner
-- connection / under withTenant for the user-facing capability check.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS assistant_features (
  id                   SERIAL PRIMARY KEY,
  master_assistant_id  INTEGER NOT NULL REFERENCES master_assistants(id) ON DELETE CASCADE,
  feature_key          TEXT NOT NULL,                       -- matches a key in ASSISTANT_FEATURES (config SoT)
  enabled              BOOLEAN NOT NULL DEFAULT false,
  updated_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT now(),
  updated_at           TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (master_assistant_id, feature_key)
);

-- Primary access path: "which features does this assistant type have?"
CREATE INDEX IF NOT EXISTS assistant_features_master_idx
  ON assistant_features (master_assistant_id);

-- Seed: pre-enable AI media generation for the live content roles.
-- All other roles start disabled; admins enable per-type as those roles go live via
-- Admin → Master Data → Assistant Features.
--
-- ⚠️ role_key MUST be a CANONICAL catalog key from db/seed-catalog.ts. This seed originally
-- targeted the legacy key 'social_media', which db/rolekey-namespace-unification.sql merged
-- into 'social_media_manager' and then DELETED — so from that migration onward this INSERT
-- silently matched ZERO rows, leaving assistant_features empty and making
-- orgHasAssistantFeature() return false for every org. The user-visible symptom was
-- "None of your assistants can generate AI images." on every AI-image surface.
--
-- Which roles get what:
--   social_media_manager — image + video (My Content media pool)
--   blog_writer          — image only    (Blog Studio feature/inline media; there is no
--                                         video surface in the Blog Studio)
-- Note the runtime gate is ORG-WIDE: any one active assistant carrying the flag unlocks the
-- feature for the whole org, on every surface.
INSERT INTO assistant_features (master_assistant_id, feature_key, enabled)
SELECT ma.id, f.key, true
FROM master_assistants ma
JOIN (VALUES
    ('social_media_manager', 'ai_image_generation'),
    ('social_media_manager', 'ai_video_generation'),
    ('blog_writer',          'ai_image_generation')
) AS f(role_key, key) ON f.role_key = ma.role_key
ON CONFLICT (master_assistant_id, feature_key) DO NOTHING;
