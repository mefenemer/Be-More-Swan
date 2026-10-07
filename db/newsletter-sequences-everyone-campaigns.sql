-- db/newsletter-sequences-everyone-campaigns.sql
-- The welcome sequence becomes "just another campaign" (2026-10-06).
--
-- Before: ONE sequence per organisation (and per assistant) could have trigger 'subscribed'
-- (everyone who joins the list), enforced by two unique indexes from db/form-builder.sql. So the
-- "everyone" audience could only ever be the welcome sequence, saving a new "everyone" campaign
-- REPLACED its emails, and every screen special-cased it.
--
-- After: any number of 'subscribed' campaigns may exist; at most ONE may be switched ON per
-- organisation — so nobody joining gets two welcome series. The app swaps them (switching one on
-- switches the other off) and the database guarantees it.
--
-- Safe to re-run. Existing data already satisfies the new index (at most one 'subscribed' per org).
-- Apply BEFORE the code that creates a second 'subscribed' campaign, or that insert hits the old index.

DROP INDEX IF EXISTS newsletter_sequences_org_welcome_uidx;
DROP INDEX IF EXISTS newsletter_sequences_assistant_welcome_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequences_org_everyone_on_uidx
  ON newsletter_sequences (organisation_id)
  WHERE trigger_event = 'subscribed' AND is_enabled;
