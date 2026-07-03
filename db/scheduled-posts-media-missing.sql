-- Issue #55: flag a draft/scheduled post in the Review Queue when a content asset (image or
-- video) attached to it is deleted from My Content. scheduled_posts.content_asset_ids is a
-- plain jsonb array with no FK, so a delete can't cascade or notify on its own — these columns
-- let content-assets.ts (DELETE) mark the affected post so the Review Queue can prompt the
-- user/assistant to source replacement media.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push).

ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS media_missing boolean NOT NULL DEFAULT false;
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS media_missing_note text;
