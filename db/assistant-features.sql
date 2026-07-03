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

-- Seed: Social Media Manager is the live, launch-ready role — pre-enable AI media generation.
-- All other roles start disabled; admins enable per-type as those roles go live.
INSERT INTO assistant_features (master_assistant_id, feature_key, enabled)
SELECT ma.id, f.key, true
FROM master_assistants ma
CROSS JOIN (VALUES ('ai_image_generation'), ('ai_video_generation')) AS f(key)
WHERE ma.role_key = 'social_media'
ON CONFLICT (master_assistant_id, feature_key) DO NOTHING;
