-- blog_posts.failure_reason — why a scheduled article did not publish.
--
-- ⚠️ APPLY ON STAGING BEFORE PUSHING, AND ON PROD BEFORE THE staging→main PR MERGES.
-- db/schema.ts names this column, and drizzle names every column in a db.select() — so until this
-- has run, EVERY read of blog_posts fails with Postgres 42703: the Blogs tab (blog-posts.ts), Blog
-- Studio, publish-blog-posts.ts, the chat's article list (content-snapshot.ts) and the blog widget.
--
-- Context: publish-blog-posts.ts set status 'failed' and only console-logged why, so neither the
-- Blogs tab nor the Blog Writer's chat could say what went wrong — the chat had to answer "no reason
-- was recorded". The publisher now writes a sentence here; booking the article again (schedule-blog.ts)
-- or publishing it (blog-publish.ts) clears it. NULL = no failure on record.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push).
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS failure_reason TEXT;

COMMENT ON COLUMN blog_posts.failure_reason IS
  'Why the last scheduled publish failed, in words for the owner (publish-blog-posts.ts). Cleared when the article is booked again or published. NULL = no failure on record.';
