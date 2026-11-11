-- db/z-content-topics.sql — Blog and Email topics as records (docs/pillar-records-plan.md §7, phase 3a).
-- Code: src/utils/pillar-profiles.ts, src/utils/content-pillars-store.ts, src/utils/blog-topic-ideation.ts,
-- netlify/functions/draft-newsletter-issues.ts. Drizzle mirror: db/schema.ts (blogPosts, newsletterIssues).
--
-- A Blog or Email assistant's topics are content_pillars rows on that assistant (no new table: the
-- assistant's role says what the rows are). Each blog post and email now records the topic it was
-- written under, so drafting can give the next one the topic used least, and Results can count them.
-- pillar_id keeps the link through a rename; pillar keeps the name, as scheduled_posts.pillar does.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys (db/schema.ts lists the
-- columns, so every whole-row select of blog_posts or newsletter_issues fails until they exist). Idempotent.
--   npm run db:migrate:apply -- --only z-content-topics.sql                              (staging)
--   npm run db:migrate:apply -- --only z-content-topics.sql --url-var DATABASE_URL_PROD  (prod)
-- Then: npx tsx scripts/backfill-content-pillars.ts (dry run), then with --apply. It now seeds Blog and
-- Email assistants too.

BEGIN;

ALTER TABLE blog_posts
    ADD COLUMN IF NOT EXISTS pillar_id INTEGER REFERENCES content_pillars(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pillar TEXT;
CREATE INDEX IF NOT EXISTS blog_posts_pillar_id_idx
    ON blog_posts (assistant_id, pillar_id) WHERE pillar_id IS NOT NULL;

ALTER TABLE newsletter_issues
    ADD COLUMN IF NOT EXISTS pillar_id INTEGER REFERENCES content_pillars(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pillar TEXT;
CREATE INDEX IF NOT EXISTS newsletter_issues_pillar_id_idx
    ON newsletter_issues (assistant_id, pillar_id) WHERE pillar_id IS NOT NULL;

COMMIT;

-- Check: expect four true.
SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'blog_posts' AND column_name = 'pillar_id') AS blog_pillar_id,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'blog_posts' AND column_name = 'pillar') AS blog_pillar,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'newsletter_issues' AND column_name = 'pillar_id') AS email_pillar_id,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'newsletter_issues' AND column_name = 'pillar') AS email_pillar;
