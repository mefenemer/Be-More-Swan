-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzz-discussions-paused.sql — Help Centre: the Lead
-- Generator's Discussions tab is PAUSED (owner, 2026-11-10; DISCUSSIONS_ENABLED in
-- src/config/discussion-sites.ts). Ask Your Team answers only from published articles, so the article
-- is unpublished (kept, not deleted) and the Mentor article stops listing forum watching.
--
-- Safe on both DBs at any time, and safe to run twice: each statement matches nothing if the article
-- was never published or the line was never added. To bring the feature back, flip is_published to
-- true and re-run db/help-articles-2026-12zzzzzzzzzzzzzz-mentor-sees-discussions.sql.

UPDATE help_articles
   SET is_published = false, updated_at = now()
 WHERE title = 'Finding Forum Threads Worth Replying To'
   AND is_published = true
RETURNING title, is_published;

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         '- **Your Lead Generator''s forum watching:** what it watches and how many threads are waiting (never the threads or replies themselves)
', ''),
       updated_at = now()
 WHERE title = 'Meet Your Business Mentor'
   AND content_md LIKE '%forum watching%'
RETURNING title, content_md LIKE '%forum watching%' AS still_mentions;

-- Check (expect false, false):
--   SELECT bool_or(is_published) FILTER (WHERE title = 'Finding Forum Threads Worth Replying To'),
--          bool_or(content_md LIKE '%forum watching%') FILTER (WHERE title = 'Meet Your Business Mentor')
--     FROM help_articles;
