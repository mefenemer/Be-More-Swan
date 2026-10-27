-- db/z-rename-found-leads-to-all-leads.sql
-- The Lead Generator's "Found leads" tab is now "All leads" (owner, 2026-10-27): it holds every lead
-- at every stage — emailed, won and lost included — and "Found" read as step two of the funnel only.
-- Help-article copy follows, the same way db/z-rename-found-leads-help-followup.sql did it.
-- Named so it sorts AFTER that file (…-found-leads-h… < …-found-leads-t…), which writes the old name.
--
-- ⚠️ The title is renamed IN PLACE with an UPDATE: ON CONFLICT (title) cannot rename, and an insert
-- would leave the old article published beside the new one.
--
-- Idempotent: only rows still containing an old phrase are touched, and no new phrase contains an
-- old one. RETURNING so the Neon editor reports what changed. No semicolons inside string literals
-- (the Neon editor splits pasted scripts on them).

UPDATE help_articles
   SET title = 'The All Leads Tab: Working a Lead Up',
       updated_at = now()
 WHERE title = 'The Found Leads Tab: Working a Lead Up'
   AND NOT EXISTS (SELECT 1 FROM help_articles WHERE title = 'The All Leads Tab: Working a Lead Up')
RETURNING title, is_published;

UPDATE help_articles
   SET content_md = replace(replace(content_md, 'Found Leads', 'All Leads'), 'Found leads', 'All leads'),
       updated_at = now()
 WHERE content_md LIKE '%Found Leads%'
    OR content_md LIKE '%Found leads%'
RETURNING title, is_published, length(content_md) AS chars;

-- What is left that still says "Found leads" in a PUBLISHED article — expected: no rows.
SELECT title, substring(content_md from position('Found ' in content_md) - 40 for 100) AS context
  FROM help_articles
 WHERE is_published
   AND content_md ~ 'Found [Ll]eads';
