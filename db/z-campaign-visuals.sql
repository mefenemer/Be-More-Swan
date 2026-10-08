-- db/z-campaign-visuals.sql — a campaign commissions pictures from the Brand Designer.
-- Brand Designer plan, Phase 3 (docs/brand-designer-plan.md §4.2) and campaign plan §10.
-- Code: src/utils/campaign-visual-order.ts, the commission_visuals executor in campaign-orders.ts,
-- the reconciler's judgeVisualOrder. Drizzle mirror: db/schema.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-campaign-visuals                              (staging)
--   npm run db:migrate:apply -- --only z-campaign-visuals --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ ORDER: visual_briefs is read with a bare db.select() (visual-briefs.ts) and the mirror below
-- names the two new columns — code before DDL breaks the Briefs tab.
--
-- ── Two constraint widenings, DROP-then-ADD ─────────────────────────────────
-- That pattern has died half-way through a production migration before and silently skipped the
-- rest of its file. Here both pairs sit in ONE transaction (all or nothing), each DROP names a
-- constraint this codebase owns, and each new list is a SUPERSET of the old one, so no existing row
-- can fail the re-added check.

BEGIN;

-- Which campaign (and which of its orders) a brief was commissioned by. SET NULL both ways: a
-- picture the user approved outlives the campaign that asked for it.
ALTER TABLE visual_briefs
  ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE visual_briefs
  ADD COLUMN IF NOT EXISTS campaign_order_id INTEGER REFERENCES campaign_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS visual_briefs_campaign_order_idx
  ON visual_briefs (campaign_order_id) WHERE campaign_order_id IS NOT NULL;

ALTER TABLE visual_briefs DROP CONSTRAINT IF EXISTS visual_briefs_origin_check;
ALTER TABLE visual_briefs ADD CONSTRAINT visual_briefs_origin_check
  CHECK (origin IN ('user', 'chat', 'campaign'));

ALTER TABLE campaign_orders DROP CONSTRAINT IF EXISTS campaign_orders_artefact_check;
ALTER TABLE campaign_orders ADD CONSTRAINT campaign_orders_artefact_check
  CHECK (artefact_kind IS NULL OR artefact_kind IN (
    'scheduled_post','blog_post','discovery_campaign','assistant_record',
    'newsletter_sequence','newsletter_issue','visual_brief'));

-- "Works with" now has something true to say. Guarded so a re-run, or an admin's own edit, is left
-- alone: the Brand Designer only moves off 'standalone' if it is still exactly that, and the
-- Campaign Assistant only gains the entry it does not already have.
UPDATE master_assistants SET works_with = '["campaign_orchestrator"]'::jsonb
 WHERE role_key = 'brand_designer' AND works_with = '["standalone"]'::jsonb;
UPDATE master_assistants SET works_with = works_with || '["brand_designer"]'::jsonb
 WHERE role_key = 'campaign_orchestrator' AND NOT (works_with ? 'brand_designer');

COMMIT;
