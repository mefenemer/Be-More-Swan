-- Migration: EU AI Act Article 50 backfill
-- Sets aiDisclosureFooterEnabled = true for all existing organisations
-- whose billing country is an EU member state.
-- Run once: psql $DATABASE_URL -f db/eu-disclosure-backfill.sql
--
-- Note: billing_information is keyed by user_id (not organisation_id), so this
-- routes billing → user → organisation. Idempotent (only flips false→true).

UPDATE organisations o
SET    ai_disclosure_footer_enabled = true
FROM   billing_information bi
JOIN   users u ON u.id = bi.user_id
WHERE  o.id = u.organisation_id
  AND  UPPER(bi.country) IN (
    'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR',
    'HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'
  )
  AND  o.ai_disclosure_footer_enabled = false;
