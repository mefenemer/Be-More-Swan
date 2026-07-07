-- Autonomous Content Engine — Native BMS widget config + A/B aggregates (US 3.1, 5.2).
--
-- widget_configs: one row per embeddable widget for a workspace. public_key is the unguessable,
-- rotatable identifier baked into the <script data-bms-key> snippet; the public widget-api function
-- resolves it to an org and serves only that org's published blog_posts. theme drives client-side
-- styling (accent hex, font, layout, custom CSS, badge toggle). allowed_origins optionally locks the
-- CORS/referrer surface. See docs/content-engine-epic-plan.md §8.
--
-- blog_ab_stats: aggregate engagement counters per (blog_post, variant), upserted by the
-- widget-ab-beacon function. Counters (not raw rows) keep storage bounded; resolve-ab-tests reads
-- these to pick a winner. Anonymous — no PII, no cookies (US 6.1 posture). See §11.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS widget_configs (
  id                  SERIAL PRIMARY KEY,
  organisation_id     INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  public_key          TEXT NOT NULL UNIQUE,                    -- 'wgt_<nanoid>' — baked into the embed snippet
  name                TEXT NOT NULL DEFAULT 'Default',         -- human label when a workspace has several embeds
  theme               JSONB NOT NULL DEFAULT '{}'::jsonb,      -- { accent, fontFamily, layout, customCss, badge }
  allowed_origins     TEXT[],                                  -- optional origin allowlist; null = any (public read)
  badge_enabled       BOOLEAN NOT NULL DEFAULT true,           -- AI Transparency Badge (US 6.1 AC2)
  status              TEXT NOT NULL DEFAULT 'active',          -- active | disabled
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT widget_configs_status_check CHECK (status IN ('active','disabled'))
);

CREATE INDEX IF NOT EXISTS widget_configs_org_idx ON widget_configs (organisation_id);

CREATE TABLE IF NOT EXISTS blog_ab_stats (
  blog_post_id     INTEGER NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  variant_id       TEXT NOT NULL,                              -- 'A' | 'B' | 'C'
  impressions      INTEGER NOT NULL DEFAULT 0,
  engaged_count    INTEGER NOT NULL DEFAULT 0,                 -- visitors past the engagement bar
  sum_dwell_ms     BIGINT  NOT NULL DEFAULT 0,
  sum_scroll_pct   BIGINT  NOT NULL DEFAULT 0,
  updated_at       TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT blog_ab_stats_pk UNIQUE (blog_post_id, variant_id)
);

CREATE INDEX IF NOT EXISTS blog_ab_stats_post_idx ON blog_ab_stats (blog_post_id);
