-- db/help-articles-2026-12zzzzzzzzzzzzzz-mentor-sees-discussions.sql — Help Centre: the Business Mentor
-- now sees the Lead Generator's Discussions tab, as counts (2026-10-30).
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzzzzz-discussions.sql. Adds one line to "What it can see"
-- in 'Meet Your Business Mentor', the same words as the "What I can see" panel
-- (src/config/mentor-data-inventory.ts, discussion_watches + discussions → always).
--
-- REPLACE on an exact string, guarded: a no-op once applied, safe to re-run. Apply on PROD only after
-- the staging→main release that ships it. Staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzzzzz-mentor-sees-discussions --execute --yes

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         '- **Your plan** and the tasks used this month',
         '- **Your Lead Generator''s forum watching:** what it watches and how many threads are waiting (never the threads or replies themselves)
- **Your plan** and the tasks used this month'),
       updated_at = now()
 WHERE title = 'Meet Your Business Mentor'
   AND content_md NOT LIKE '%forum watching%'
RETURNING title, length(content_md);

-- Check (expect 1 row, true):
--   SELECT title, content_md LIKE '%forum watching%' FROM help_articles WHERE title = 'Meet Your Business Mentor';
