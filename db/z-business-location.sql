-- db/z-business-location.sql — where customers find the business, for the website's "Opening hours &
-- contact" section (and its search data). Business Information ▸ Hours, Location & Bookings.
-- Code: src/utils/business-hours.ts, src/utils/booking-settings.ts, src/utils/site-render.ts.
-- Drizzle mirror: db/schema.ts (bookingSettings).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-business-location.sql                              (staging)
--   npm run db:migrate:apply -- --only z-business-location.sql --url-var DATABASE_URL_PROD  (prod)
--
-- visit_address  the address customers come to (lines separated by newlines). Deliberately NOT the
--                billing / registered address or the outreach postal address: those can be an
--                accountant's office or a home, and this one is published on the website.
-- whatsapp       a number customers can message on WhatsApp (the site links to wa.me).

BEGIN;

ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS visit_address TEXT;
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS whatsapp      TEXT;

COMMIT;
