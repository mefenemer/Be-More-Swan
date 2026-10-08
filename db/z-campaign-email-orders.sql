-- db/z-campaign-email-orders.sql — a campaign can brief the Email Marketing Assistant.
-- Design: docs/campaign-orchestrator-plan.md §9.7. Code: src/utils/campaign-email-order.ts.
-- Drizzle mirror: db/schema.ts (newsletterIssues.campaignOrderId, newsletterSequences.campaignOrderId,
-- campaign_orders_artefact_check).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-campaign-email-orders                              (staging)
--   npm run db:migrate:apply -- --only z-campaign-email-orders --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ DEPLOY ORDER IS NOT OPTIONAL, and the blast radius is the EMAIL STUDIO, not just campaigns:
-- newsletter-issues.ts and newsletter-sequences.ts do bare `db.select()` reads that name every
-- mirrored column, so code that knows campaign_order_id, against a database without it, breaks
-- every customer's Email Studio (schema-column-breaks-reads-until-applied).
--
-- ── campaign_order_id on issues and sequences ───────────────────────────────
-- The trace from an email back to the campaign that commissioned it. Without it the campaign
-- cannot count the opens and clicks its emails earned (outcome `email_engagement`), and the
-- reconciler cannot tell whether the user sent, turned on, or threw away what was drafted.
-- ON DELETE SET NULL: an email that went out is a record of what was sent; deleting the order
-- (or the campaign) must never delete it.
--
-- ── Widening campaign_orders_artefact_check ─────────────────────────────────
-- DROP-then-ADD, which has died half-way through a production migration before and silently
-- skipped the rest of its file. Here it is the ONLY statement pair in the file's constraint work,
-- it sits inside the same transaction as everything else (all or nothing), and the DROP names the
-- constraint this codebase owns. The new list is a SUPERSET of the old one, so no existing row can
-- fail the re-added check.

BEGIN;

ALTER TABLE newsletter_issues
  ADD COLUMN IF NOT EXISTS campaign_order_id INTEGER REFERENCES campaign_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS newsletter_issues_campaign_order_idx
  ON newsletter_issues (campaign_order_id) WHERE campaign_order_id IS NOT NULL;

ALTER TABLE newsletter_sequences
  ADD COLUMN IF NOT EXISTS campaign_order_id INTEGER REFERENCES campaign_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS newsletter_sequences_campaign_order_idx
  ON newsletter_sequences (campaign_order_id) WHERE campaign_order_id IS NOT NULL;

ALTER TABLE campaign_orders DROP CONSTRAINT IF EXISTS campaign_orders_artefact_check;
ALTER TABLE campaign_orders ADD CONSTRAINT campaign_orders_artefact_check
  CHECK (artefact_kind IS NULL OR artefact_kind IN (
    'scheduled_post','blog_post','discovery_campaign','assistant_record',
    'newsletter_sequence','newsletter_issue'));

COMMIT;
