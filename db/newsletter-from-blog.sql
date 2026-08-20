-- db/newsletter-from-blog.sql
-- Blog post → newsletter issue: the link back from an issue to the post that prompted it.
-- Requires db/newsletter.sql and db/blog-posts.sql.
--
-- ── What this is for ────────────────────────────────────────────────────────────────────────────
-- When a Blog Writer publishes and an orchestration link points at a Newsletter Assistant, we draft
-- an issue about that post. The column records WHICH post, and it does three jobs:
--
--   1. ⚠️ IT IS THE IDEMPOTENCY KEY. Publishing is not a one-time event — unpublish/republish is a
--      supported, lossless round trip on blog_posts, and every republish fires the hand-off again.
--      Without a unique index the second publish drafts a second issue about the same post, and the
--      tenant's review queue fills with duplicates of an email they already approved.
--   2. It lets the issue say where it came from ("Drafted from your blog post …"), which is the
--      difference between an assistant that explains itself and one that surprises you.
--   3. It survives the post being deleted — SET NULL, not CASCADE. The issue may already have been
--      sent to a few thousand people, and deleting a draft post must not delete the record of it.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE: db/schema.ts names this column, and a
-- `db.select()` on newsletter_issues names every column in the table — the single-issue GET in
-- newsletter-issues.ts would 500 on an environment where the column does not exist yet.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'newsletter_issues') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-from-blog.sql requires db/newsletter.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only newsletter.sql  (then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

ALTER TABLE newsletter_issues
  ADD COLUMN IF NOT EXISTS source_blog_post_id INTEGER REFERENCES blog_posts(id) ON DELETE SET NULL;

-- One issue per post PER ASSISTANT, rather than one per post outright. Two Newsletter Assistants in
-- the same org that both watch the blog are two deliberate links, and each should get its own draft;
-- what must never happen is the same assistant drafting the same post twice.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_issues_source_post_uidx
  ON newsletter_issues (assistant_id, source_blog_post_id)
  WHERE source_blog_post_id IS NOT NULL AND assistant_id IS NOT NULL;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'newsletter_issues' AND column_name = 'source_blog_post_id';
