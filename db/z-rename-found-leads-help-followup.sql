-- db/z-rename-found-leads-help-followup.sql
-- Follow-up to db/z-rename-email-flows-found-leads.sql (2026-10-22). That file renamed "Enrichment tab"
-- and "**Enrichment**" in help-article BODIES, but not:
--   • the article TITLE "The Enrichment Tab: Working a Lead Up" (and its H1), and
--   • three other spellings: "**Move to Enrichment**", "Searches, Enrichment, Outreach" and
--     "The Enrichment Tab".
--
-- ⚠️ The title is renamed IN PLACE with an UPDATE, not by inserting a new row: ON CONFLICT (title)
-- cannot rename, and an insert would leave the old article published beside the new one. The seed
-- files (db/seed-help-articles.sql) now carry the new title, so a later re-seed upserts THIS row.
-- No other article links to it by its #slug (checked 2026-10-22), so the slug change breaks nothing.
--
-- Untouched on purpose: "Send back for enrichment" (a button name, lower case) and the retired,
-- unpublished "How Automated Data Enrichment Works".
--
-- Idempotent: only rows still containing an old phrase are touched, and no new phrase contains an old
-- one. RETURNING on each statement so the Neon editor reports what it changed. No semicolons inside
-- string literals (the Neon editor splits pasted scripts on them).

UPDATE help_articles
   SET title = 'The Found Leads Tab: Working a Lead Up',
       updated_at = now()
 WHERE title = 'The Enrichment Tab: Working a Lead Up'
   AND NOT EXISTS (SELECT 1 FROM help_articles WHERE title = 'The Found Leads Tab: Working a Lead Up')
RETURNING title, is_published;

UPDATE help_articles
   SET content_md = replace(replace(replace(replace(content_md,
           'The Enrichment Tab', 'The Found Leads Tab'),
           '**Move to Enrichment**', '**Move to Found leads**'),
           'Searches, Enrichment, Outreach', 'Searches, Found leads, Outreach'),
           '**Enrichment**', '**Found leads**'),
       updated_at = now()
 WHERE content_md LIKE '%The Enrichment Tab%'
    OR content_md LIKE '%**Move to Enrichment**%'
    OR content_md LIKE '%Searches, Enrichment, Outreach%'
    OR content_md LIKE '%**Enrichment**%'
RETURNING title, is_published, length(content_md) AS chars;

-- What is left that still says "Enrichment" in a PUBLISHED article — expected: no rows.
SELECT title, substring(content_md from position('Enrichment' in content_md) - 40 for 100) AS context
  FROM help_articles
 WHERE is_published
   AND content_md ~ 'Enrichment'
   AND content_md !~ 'Data Enrichment';
