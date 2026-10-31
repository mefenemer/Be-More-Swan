-- db/z-no-website-page-limit.sql — plan master data (owner decision, 2026-10-31).
--
-- No plan limits website pages. The Website Assistant used to read master_plans.features.website_pages
-- (5 on the Workflow Saver, 15 on the Busywork Buster, 50 on the retired Digital Employee). The code no
-- longer reads it (src/utils/site-store.ts maxPagesFor → DEFAULT_MAX_PAGES, a 100-page safety ceiling
-- that is not advertised), so this removes the stored values, switches the pricing-table row off
-- (is_enabled only hides a row from get-plans' catalog — nothing else reads it), and replaces the
-- Website Assistant's public FAQ answer. db/z-assistant-showcases.sql carries the same answer for a
-- fresh database.
--
-- Every statement RETURNs what it changed, so the Neon SQL editor shows a result either way.
-- Safe to re-run. Apply on staging, then prod.

BEGIN;

UPDATE master_plans
   SET features = features - 'website_pages'
 WHERE features ? 'website_pages'
RETURNING tier_key, features ? 'website_pages' AS still_has_pages;

UPDATE plan_features
   SET is_enabled = FALSE, updated_at = now()
 WHERE key = 'website_pages'
RETURNING key, is_enabled;

UPDATE assistant_showcases
   SET content = REPLACE(content::text,
                   'Up to 5 pages on the Workflow Saver plan and 15 on the Busywork Buster.',
                   'As many as your site needs. No plan limits how many pages your website has.')::jsonb,
       updated_at = now()
 WHERE role_key = 'website_assistant'
   AND content::text LIKE '%Up to 5 pages on the Workflow Saver plan%'
RETURNING role_key;

COMMIT;

-- Check (expect no plan with website_pages, the row off, and the new answer):
--   SELECT tier_key FROM master_plans WHERE features ? 'website_pages';
--   SELECT key, is_enabled FROM plan_features WHERE key = 'website_pages';
--   SELECT content::text LIKE '%No plan limits how many pages%' FROM assistant_showcases WHERE role_key = 'website_assistant';
