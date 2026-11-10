-- db/z-content-deletion-warning.sql (2026-11-10)
-- My Content: a file is only deleted after its owner was told a week before (src/utils/library-retention.ts).
-- Apply to BOTH databases (staging and prod) BEFORE deploying: content-assets.ts selects whole rows.
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS deletion_warned_at timestamp;
