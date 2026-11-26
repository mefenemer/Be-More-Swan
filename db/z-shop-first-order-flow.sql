-- db/z-shop-first-order-flow.sql
-- "First order" email flows (online shop Phase 2, slice 4b; feature request #35, docs/online-shop-review-plan.md §12).
--
-- A third thing that can start an email flow by itself: a shop buyer who ticked "Send me news" on the basket page
-- paying for their FIRST order (src/utils/shop-first-order-flow.ts). Like "everyone who subscribes", at most ONE
-- such flow may be switched on per workspace, so a first order never starts two series.
--
-- Safe to re-run. Additive: existing rows are all 'subscribed' or 'form', which the new check still allows.
-- MANUAL — apply on staging, then on prod on the owner's word. Until it is applied, choosing "People who place
-- their first order" in the Email Studio says the workspace needs an update (409 NEEDS_UPDATE) and nothing changes.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'newsletter_sequences_trigger_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%first_order%'
  ) THEN
    ALTER TABLE newsletter_sequences DROP CONSTRAINT newsletter_sequences_trigger_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sequences_trigger_check') THEN
    ALTER TABLE newsletter_sequences ADD CONSTRAINT newsletter_sequences_trigger_check
      CHECK (trigger_event IN ('subscribed', 'form', 'first_order'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequences_org_first_order_on_uidx
  ON newsletter_sequences (organisation_id)
  WHERE trigger_event = 'first_order' AND is_enabled;
