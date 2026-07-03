-- US-SMM-PERF: Social Performance Metrics ingestion.
-- One upserted snapshot per published post, holding the platform's engagement
-- counters. Written by the ingest-instagram-insights cron and aggregated per
-- assistant by get-assistant-metrics.ts. Idempotent — safe to run more than once.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled tables.
-- Canonical column definitions live in db/schema.ts (export const postInsights).
--
-- RLS: intentionally NOT enabled here. Both writers (ingest-instagram-insights) and
-- the reader (get-assistant-metrics) query this table via getDb() (the neondb_owner
-- connection, which bypasses RLS) and filter by organisation_id explicitly — the same
-- owner-path + manual-filter pattern as audit_logs / get-assistant-activity.ts. No
-- function routes post_insights through withTenant(), so a tenant_isolation policy
-- would add no protection. If a withTenant() caller is ever added, enable RLS here in
-- lockstep, mirroring db/rls/R1-crown-jewels.sql.

CREATE TABLE IF NOT EXISTS post_insights (
    id                  serial PRIMARY KEY,
    scheduled_post_id   integer NOT NULL REFERENCES scheduled_posts(id)   ON DELETE CASCADE,
    organisation_id     integer NOT NULL REFERENCES organisations(id)     ON DELETE CASCADE,
    assistant_id        integer          REFERENCES ai_assistants(id)     ON DELETE SET NULL,
    connection_id       integer          REFERENCES system_connections(id) ON DELETE SET NULL,
    platform            text NOT NULL,              -- instagram | facebook | linkedin | x
    platform_post_id    text NOT NULL,              -- external media/post id
    published_at        timestamp,

    -- Raw counters as returned by the platform (NULL where unsupported).
    reach               integer,
    impressions         integer,                    -- deprecated on newer IG media — may be NULL
    likes               integer,
    comments            integer,
    shares              integer,
    saves               integer,
    total_interactions  integer,                    -- engagement numerator
    video_views         integer,
    link_clicks         integer,                    -- NULL for IG organic feed — reserved for platforms that expose it

    raw                 jsonb,                      -- full insights payload for debugging / future metrics
    fetched_at          timestamp NOT NULL DEFAULT now(),
    created_at          timestamp NOT NULL DEFAULT now(),
    updated_at          timestamp NOT NULL DEFAULT now()
);

-- One snapshot per post — the ingester upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS post_insights_post_uidx
    ON post_insights (scheduled_post_id);

-- Per-assistant aggregation over a time window (get-assistant-metrics.ts).
CREATE INDEX IF NOT EXISTS post_insights_assistant_published_idx
    ON post_insights (assistant_id, published_at);

-- Org-scoped + platform reporting.
CREATE INDEX IF NOT EXISTS post_insights_org_platform_idx
    ON post_insights (organisation_id, platform);
