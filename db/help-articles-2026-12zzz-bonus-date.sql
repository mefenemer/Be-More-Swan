-- db/help-articles-2026-12zzz-bonus-date.sql — Help Centre: the bonus-task conversion date.
--
-- Sorts after db/help-articles-2026-12zz-brand-designer-tasks.sql. "Billing & Your Plan (from
-- October 2026)" said leftover credits became bonus tasks on 1 December 2026. The single task
-- allowance went live, and the conversion ran, on 17 October 2026 (db/ops/task-allowance-cutover.sql).
-- REPLACE on an exact string: a no-op once applied, safe to re-run.

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         'unused X posting credits on 1 December 2026, they became bonus tasks',
         'unused X posting credits on 17 October 2026, they became bonus tasks'),
       updated_at = now()
 WHERE title = 'Billing & Your Plan (from October 2026)'
   AND content_md LIKE '%unused X posting credits on 1 December 2026, they became bonus tasks%';
