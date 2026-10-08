-- db/z-campaign-creative.sql — a campaign's tone of voice and its own visuals. Plan §9.3.
-- Code: src/config/campaign-creative.ts, media-resolver.ts (campaign assets first), blueprint §13.
-- Drizzle mirror: db/schema.ts (campaigns.tone, campaignAssets).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-campaign-creative                              (staging)
--   npm run db:migrate:apply -- --only z-campaign-creative --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ Deploy order: campaigns.ts `requireCampaign()` selects every mirrored campaigns column, so
-- code that knows `tone` must not reach a database without it.
--
-- ── Why a link table, not a campaign_id on content_assets ───────────────────
-- Two reasons. (1) One picture can serve two campaigns — the launch hero shot also anchors the
-- always-on brand campaign — and a single column cannot say that. (2) content_assets is read with
-- bare `db.select()` by the media library (content-assets.ts), so a new column there would break
-- every tenant's library on an un-migrated environment. A new table cannot break an existing read.
--
-- ON DELETE CASCADE both ways: the link means nothing once either side is gone, and an asset the
-- retention sweep purges must not linger as a campaign visual pointing at deleted bytes.

BEGIN;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS tone TEXT;

CREATE TABLE IF NOT EXISTS campaign_assets (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    campaign_id      INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    content_asset_id INTEGER NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_assets_pair_uidx ON campaign_assets (campaign_id, content_asset_id);
CREATE INDEX IF NOT EXISTS campaign_assets_asset_idx ON campaign_assets (content_asset_id);

COMMIT;

-- RLS: deliberately not enabled, as for every campaign table — see the foot of db/campaigns.sql.
