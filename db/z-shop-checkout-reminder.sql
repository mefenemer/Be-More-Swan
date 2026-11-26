-- db/z-shop-checkout-reminder.sql
-- The abandoned-checkout reminder (online shop Phase 2, slice 5; feature request #35, docs/online-shop-review-plan.md §12).
-- Code: src/utils/shop-checkout-reminder.ts (the only reader and writer of these columns), src/utils/site-shop.ts
-- (basket checkout saves the email), netlify/functions/stripe-connect-webhook.ts (checkout.session.expired → the
-- reminder), netlify/functions/shop-reminder-stop.ts (its unsubscribe link), src/utils/shop-basket.ts (the sweep).
--
-- APPLY MANUALLY, staging first, then prod on the owner's word. Additive and idempotent.
--   node -r dotenv/config scripts/db-migrate.mjs apply --only z-shop-checkout-reminder.sql --execute --yes                               (staging)
--   node -r dotenv/config scripts/db-migrate.mjs apply --only z-shop-checkout-reminder.sql --url-var DATABASE_URL_PROD --execute --yes  (prod)
--
-- Before it runs: no email is kept, no reminder is sent, the Shop tab shows no reminder line; checkout works as before.
--
-- reminder_email       the address a buyer typed beside the ticked "Send me news" box on the basket page (never
--                      kept for an unticked checkout; cleared by the reminder's unsubscribe link).
-- checkout_expires_at  when that checkout lapses (1 hour after it started) — for reading by eye.
-- reminded_at          set when the ONE reminder is claimed; a basket is never reminded twice. A reminded basket is
--                      kept 60 days from its reminder (not 7) so the email's unsubscribe link keeps working.
-- reminder_result      sent | no_route (no sending domain or mailbox) | refused (the address may not be emailed) | failed

ALTER TABLE site_baskets ADD COLUMN IF NOT EXISTS reminder_email TEXT;
ALTER TABLE site_baskets ADD COLUMN IF NOT EXISTS checkout_expires_at TIMESTAMP;
ALTER TABLE site_baskets ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMP;
ALTER TABLE site_baskets ADD COLUMN IF NOT EXISTS reminder_result TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_baskets_reminder_result_check') THEN
    ALTER TABLE site_baskets ADD CONSTRAINT site_baskets_reminder_result_check
      CHECK (reminder_result IS NULL OR reminder_result IN ('sent', 'no_route', 'refused', 'failed'));
  END IF;
END $$;

-- The Shop tab's "this week" line reads one workspace's reminded baskets.
CREATE INDEX IF NOT EXISTS site_baskets_org_reminded_idx ON site_baskets (organisation_id, reminded_at) WHERE reminded_at IS NOT NULL;
