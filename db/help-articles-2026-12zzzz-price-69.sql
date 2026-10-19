-- db/help-articles-2026-12zzzz-price-69.sql — Help Centre: plan prices come from master data.
--
-- Sorts after db/help-articles-2026-12zzz-bonus-date.sql. Owner, 2026-10-19: The Busywork Buster
-- moved from £79 to £69, and no surface may carry its own copy of a price. The "Billing & Your
-- Plan" tables now say {{plans.saver_price}} / {{plans.buster_price}}, which get-help-articles.ts
-- fills from master_plans (src/utils/plan-price-tokens.ts) every time an article is read.
--
-- ⚠️ ORDER: deploy the code that fills the tokens FIRST. Before it, readers see the raw
-- "{{plans.buster_price}}" text in the table.
--
-- REPLACE on exact strings: a no-op once applied, safe to re-run. The retired Digital Employee row
-- (£349) in the old, unpublished article is history and is left as it is.

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(content_md,
         '| **The Workflow Saver** | £29 / month |', '| **The Workflow Saver** | {{plans.saver_price}} / month |'),
         '| **The Busywork Buster** | £79 / month |', '| **The Busywork Buster** | {{plans.buster_price}} / month |'),
       updated_at = now()
 WHERE title IN ('Billing & Your Plan', 'Billing & Your Plan (from October 2026)')
   AND (content_md LIKE '%| **The Workflow Saver** | £29 / month |%'
        OR content_md LIKE '%| **The Busywork Buster** | £79 / month |%');
