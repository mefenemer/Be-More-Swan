-- db/z-booking-meeting-providers.sql — a Teams (later Google Meet) meeting made for each video booking,
-- and video links for online classes (docs/booking-calendly-gaps-plan.md, B step 2 + small items).
-- Code: src/utils/booking-meeting.ts, calendar-microsoft.ts, class-sessions.ts, booking-settings.ts.
-- Drizzle mirror: db/schema.ts. Needs db/z-booking-meeting-links.sql first.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
-- (Every bookings / booking_settings / class_sessions read selects these columns.)
--   npm run db:migrate:apply -- --only z-booking-meeting-providers.sql                              (staging)
--   npm run db:migrate:apply -- --only z-booking-meeting-providers.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── booking_settings.meeting_provider / meeting_provider_error ─────────────
-- How video links are made: 'link' (NULL — the pasted link, as before) | 'teams' (a Teams meeting
-- per booking, through the signed-in Outlook calendar) | 'meet' (a Google Meet per booking, through
-- the signed-in Google calendar). meeting_provider_error: why the last one couldn't be made, in words.
--
-- ── bookings.meeting_source ────────────────────────────────────────────────
-- Where meeting_url came from: 'link' (NULL — the pasted link; follows the owner's changes) |
-- 'teams' | 'meet' (made for this booking; never overwritten when the pasted link changes).
--
-- ── class_sessions.meeting_url ─────────────────────────────────────────────
-- An online class or event: its video link, copied onto each place booked (shown once confirmed).

BEGIN;

ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS meeting_provider       TEXT;
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS meeting_provider_error TEXT;
ALTER TABLE bookings         ADD COLUMN IF NOT EXISTS meeting_source         TEXT;
ALTER TABLE class_sessions   ADD COLUMN IF NOT EXISTS meeting_url            TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'booking_settings'::regclass AND conname = 'booking_settings_meeting_provider_check') THEN
        ALTER TABLE booking_settings ADD CONSTRAINT booking_settings_meeting_provider_check
            CHECK (meeting_provider IS NULL OR meeting_provider IN ('link', 'teams', 'meet'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_meeting_source_check') THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_meeting_source_check
            CHECK (meeting_source IS NULL OR meeting_source IN ('link', 'teams', 'meet'));
    END IF;
END $$;

COMMIT;
