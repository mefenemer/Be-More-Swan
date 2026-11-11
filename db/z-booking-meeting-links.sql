-- db/z-booking-meeting-links.sql — where a booking happens, and the video link (docs/booking-calendly-gaps-plan.md, B step 1).
-- Code: src/utils/booking-meeting.ts, bookings.ts (createBooking, emails, .ics), site-booking.ts,
-- booking-settings.ts, org-products.ts, calendar-microsoft.ts, booking-calendar-feed.ts. Drizzle mirror: db/schema.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
-- (Every bookings / booking_settings / bookable_resources read selects these columns.)
--   npm run db:migrate:apply -- --only z-booking-meeting-links.sql                              (staging)
--   npm run db:migrate:apply -- --only z-booking-meeting-links.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── org_products.meeting_location ──────────────────────────────────────────
-- Per service: 'in_person' | 'phone' (the customer's phone number becomes required; the business
-- calls them) | 'video'. NULL = in person, as every service was before.
--
-- ── booking_settings.meeting_url / bookable_resources.meeting_url ──────────
-- A reusable video link the owner pastes (a Zoom personal room, a fixed Google Meet or Teams link):
-- the business's, or one person's (which wins for their bookings). https only.
--
-- ── bookings.meeting_location / meeting_url ────────────────────────────────
-- Copied onto the booking when it is made (the service's location; for video, the person's link or
-- the business's). Shown to the customer only once the booking is confirmed. When the owner changes
-- a link, upcoming bookings that carried the old one are updated to the new one (booking-meeting.ts).

BEGIN;

ALTER TABLE org_products       ADD COLUMN IF NOT EXISTS meeting_location TEXT;
ALTER TABLE booking_settings   ADD COLUMN IF NOT EXISTS meeting_url      TEXT;
ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS meeting_url      TEXT;
ALTER TABLE bookings           ADD COLUMN IF NOT EXISTS meeting_location TEXT;
ALTER TABLE bookings           ADD COLUMN IF NOT EXISTS meeting_url      TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'org_products'::regclass AND conname = 'org_products_meeting_location_check') THEN
        ALTER TABLE org_products ADD CONSTRAINT org_products_meeting_location_check
            CHECK (meeting_location IS NULL OR meeting_location IN ('in_person', 'phone', 'video'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_meeting_location_check') THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_meeting_location_check
            CHECK (meeting_location IS NULL OR meeting_location IN ('in_person', 'phone', 'video'));
    END IF;
END $$;

COMMIT;
