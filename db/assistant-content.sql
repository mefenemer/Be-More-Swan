-- Assistant Content — DB-driven marketing copy for the assistant detail page/modal, plus the
-- DB-driven catalog for the per-assistant capability matrix.
-- Drizzle mirror: db/schema.ts (masterAssistants copy columns + assistantFeatureDefs).
-- Seed: db/seed-assistant-content.ts.
-- Powers Admin → Master Data → Assistants (copy fields) and → Assistant Features (capability matrix).
--
-- Why: assistant copy had two sources of truth. master_assistants held name/description/icons (read by
-- the catalogue grid), while src/config/assistant-role-content.js re-declared them AND added
-- tagline/keyFeatures/integrations/video (read by the detail page). They had already drifted — the SMM
-- card and its detail modal showed different descriptions. These columns make master_assistants the
-- only source, and the hardcoded file is deleted.
--
-- Storage model: unlike plan_features, the copy VALUES live directly on master_assistants. There is no
-- catalog/value split here because the fields are a fixed, singular set per assistant rather than a
-- shared vocabulary — a catalog would buy nothing. See assistant_feature_defs below for the part that
-- IS matrix-shaped and does mirror the plan_features pattern.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

-- ── Marketing copy: values live on master_assistants ─────────────────────────────
-- tagline      — one-line hook under the assistant name on the detail page
-- key_features — string[]; the "Key Features" bullet list
-- integrations — string[]; the integration chips
-- video        — {url, title, poster} | null; while url is null the modal renders a placeholder slot
ALTER TABLE master_assistants ADD COLUMN IF NOT EXISTS tagline      TEXT;
ALTER TABLE master_assistants ADD COLUMN IF NOT EXISTS key_features JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE master_assistants ADD COLUMN IF NOT EXISTS integrations JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE master_assistants ADD COLUMN IF NOT EXISTS video        JSONB;

-- ── Capability catalog: metadata only, mirroring plan_features ───────────────────
-- The VALUES stay in assistant_features (one row per master_assistant × feature_key; absent = off).
-- This table replaces the hardcoded ASSISTANT_FEATURES list in src/config/assistant-features.ts, so a
-- new capability no longer needs a deploy. There is no applyMode/snapshot analogue of
-- plans.feature_overrides: capability changes have no subscriber cohort and are always live.
CREATE TABLE IF NOT EXISTS assistant_feature_defs (
  id            SERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,               -- 'ai_image_generation', 'ai_video_generation', ...
  label         TEXT NOT NULL,                      -- matrix column header
  description   TEXT,                               -- column tooltip / admin help text
  category      TEXT NOT NULL,                      -- matrix section header: 'Media' | 'Engagement' | ...
  display_order INTEGER NOT NULL DEFAULT 0,
  is_enabled    BOOLEAN NOT NULL DEFAULT true,      -- false = globally disabled (hidden from the matrix, treated as off)
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_feature_defs_order_idx ON assistant_feature_defs(category, display_order);
