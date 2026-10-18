-- db/help-articles-2026-12zz-brand-designer-tasks.sql — "The Brand Designer" cost table in tasks.
--
-- Sorts after the other 2026-12 help files. Since the single task allowance (docs/task-metering.md)
-- AI media comes out of the monthly task allowance; the cost table still quoted AI media credits and
-- the retired Digital Employee plan. REPLACE on exact strings: a no-op once applied, safe to re-run.

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(content_md,
         '| AI images | 1 AI media credit for a round of four |',
         '| AI images | 1 task for a round of four |'),
         '| AI video | 5 AI media credits for one short clip — on the Busywork Buster and Digital Employee plans |',
         '| AI video | 20 tasks for one short clip — on the Busywork Buster plan |'),
       updated_at = now()
 WHERE content_md LIKE '%AI media credit%';
