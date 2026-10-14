-- db/z-campaign-picture-counts.sql
-- A campaign's picture brief asks for as many pictures as the posts it is for, and a chosen picture
-- replaces the one the Social Media Assistant found itself on a post still awaiting review.
-- Owner, 2026-10-14: "if the brief is for 10 social posts, the Brand Designer should be providing
-- options until 10 have been selected".
--
-- ⚠️ APPLY TO BOTH ENVS BEFORE THE CODE DEPLOYS. Both tables are read with bare db.select(), which
-- names every column in the drizzle mirror — the code before this file breaks every brief and post
-- read (schema-column-breaks-reads-until-applied). Idempotent: safe to run twice.

-- How many pictures this brief is for. 1 for every brief that existed before (one is what they needed).
ALTER TABLE visual_briefs ADD COLUMN IF NOT EXISTS pictures_needed integer NOT NULL DEFAULT 1;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visual_briefs_pictures_needed_check') THEN
        ALTER TABLE visual_briefs ADD CONSTRAINT visual_briefs_pictures_needed_check CHECK (pictures_needed BETWEEN 1 AND 20);
    END IF;
END $$;

-- The picture the DRAFTER attached to this post. A campaign picture may replace the post's media only
-- while the post still carries exactly this asset — any change by the user moves it off, and a
-- picture someone chose is never replaced. NULL = not drafter-picked (or posts drafted before this).
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS auto_media_asset_id integer
    REFERENCES content_assets(id) ON DELETE SET NULL;
