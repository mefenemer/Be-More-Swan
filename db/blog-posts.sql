-- Autonomous Content Engine — Phase 0 blog content model (Feature 1 / US 1.x, 3.1, 5.2).
--
-- blog_posts: the long-form Markdown counterpart to scheduled_posts (which stays social-only).
-- body_markdown is the editable source of truth; published_payload is the sanitised HTML snapshot
-- the public widget API serves (immutable, CDN-cacheable — see docs/content-engine-epic-plan.md §8).
-- Reuses the shared primitives rather than rebuilding them: content_assets (+ blog_post_assets
-- junction), content_provenance (provenance_content_id), content_generation_jobs (job_id),
-- ai_blueprints (blueprint_id), pending_actions (HITL), audit_logs (human-vs-AI edit trail, US 6.1).
--
-- blog_post_assets: ordered media junction, mirrors scheduled_post_assets exactly.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS blog_posts (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id          INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,  -- set for autonomous drafts
  owner_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_label           TEXT,                                  -- "AI: Marketing Mike" | "Jane Smith"

  -- Body
  title                 TEXT NOT NULL,
  body_markdown         TEXT NOT NULL DEFAULT '',              -- editable source of truth (US 1.2)
  published_payload     JSONB,                                 -- sanitised HTML + meta snapshot served by the widget (US 3.1)

  -- SEO metadata (US 1.3)
  slug                  TEXT,                                  -- unique per org (see partial index below)
  meta_title            TEXT,
  meta_description      TEXT,
  tags                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  canonical_url         TEXT,

  -- Hero / feature graphic
  feature_asset_id      INTEGER REFERENCES content_assets(id) ON DELETE SET NULL,

  -- A/B hook testing (US 5.2) — variants: [{ id:'A', h1, intro }, ...]
  hook_variants         JSONB NOT NULL DEFAULT '[]'::jsonb,
  winning_variant       TEXT,                                  -- null until resolve-ab-tests decides
  ab_state              TEXT NOT NULL DEFAULT 'off',           -- off|testing|decided

  -- Distribution (per-target status): { widget, substack, medium, rss }
  destinations          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Workflow & governance
  status                TEXT NOT NULL DEFAULT 'draft',
  publish_date          TIMESTAMP,
  published_at          TIMESTAMP,
  is_autonomous         BOOLEAN NOT NULL DEFAULT false,
  generation_reason     TEXT,                                  -- why an autonomous draft was created

  -- Provenance & AI linkage (reused infra)
  provenance_content_id TEXT,                                  -- references content_provenance.content_id
  confidence_score      TEXT,                                  -- 'green' | 'amber' | 'red' | null
  factual_claims        JSONB,
  job_id                TEXT,                                  -- references content_generation_jobs.job_id
  blueprint_id          INTEGER REFERENCES ai_blueprints(id) ON DELETE SET NULL,

  -- Content-decay detection (US 5.1)
  traffic_baseline      INTEGER,                               -- reference impressions/clicks for the decay threshold
  last_metrics_at       TIMESTAMP,

  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT blog_posts_status_check CHECK (status IN (
    'draft','pending_approval','in_review','approved','scheduled',
    'publishing','published','paused','failed','rejected','archived'
  )),
  CONSTRAINT blog_posts_ab_state_check CHECK (ab_state IN ('off','testing','decided'))
);

CREATE INDEX        IF NOT EXISTS blog_posts_org_status_idx    ON blog_posts (organisation_id, status);
CREATE INDEX        IF NOT EXISTS blog_posts_assistant_idx     ON blog_posts (assistant_id);
CREATE INDEX        IF NOT EXISTS blog_posts_publish_date_idx  ON blog_posts (publish_date);
-- Slug is unique per org, but only among rows that actually have a slug (drafts may not yet).
CREATE UNIQUE INDEX IF NOT EXISTS blog_posts_org_slug_unique   ON blog_posts (organisation_id, slug)
  WHERE slug IS NOT NULL;

-- Ordered media junction — mirrors scheduled_post_assets.
CREATE TABLE IF NOT EXISTS blog_post_assets (
  blog_post_id     INTEGER NOT NULL REFERENCES blog_posts(id)    ON DELETE CASCADE,
  content_asset_id INTEGER NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT blog_post_assets_pk UNIQUE (blog_post_id, content_asset_id)
);

CREATE INDEX IF NOT EXISTS blog_post_assets_post_idx ON blog_post_assets (blog_post_id);
