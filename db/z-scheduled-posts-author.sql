-- db/z-scheduled-posts-author.sql — which account actually published a post.
--
-- scheduled_posts.platform_author_urn = the platform's id for the account the publisher used
-- (LinkedIn: urn:li:organization:<id> for a Company Page, the member id for a personal profile).
-- Written by netlify/functions/publish-social-posts.ts when a post goes out.
--
-- Why: a connection row is UPDATED in place on reconnect (social-oauth-callback.ts), so a LinkedIn
-- connection that published as a personal profile can later point at a Company Page. connection_id
-- alone then claims the profile's old posts for the Page. LinkedIn Page stats and comments
-- (src/utils/page-comments.ts loadPagePosts) read ONLY posts whose author is the Page.
--
-- No backfill: we can't know after the fact who wrote an old post. Page posting has only run on
-- staging, so production loses nothing; on staging set any test post's author by hand.
--
-- APPLY MANUALLY, staging and prod separately, BEFORE the code deploys. Until it runs, the publisher
-- still publishes (it records the author in a separate, guarded update) but the Comments tab says
-- "not set up yet" and the LinkedIn ingest skips. Idempotent.

ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS platform_author_urn TEXT;

-- Check: expect 1 row.
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'scheduled_posts' AND column_name = 'platform_author_urn';
