-- db/z-calendar-sync.sql — bookings phase 3: the owner's calendar, with no sign-in (docs/booking-plan.md).
-- Code: src/utils/ical-busy.ts (reading an iCal file), src/utils/calendar-sync.ts (busy times in),
-- src/utils/booking-calendar-feed.ts + netlify/functions/booking-calendar-feed.ts (bookings out),
-- netlify/functions/sync-busy-calendars.ts (every 15 minutes). Drizzle mirror: db/schema.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-calendar-sync.sql                              (staging)
--   npm run db:migrate:apply -- --only z-calendar-sync.sql --url-var DATABASE_URL_PROD  (prod)
--
-- OUT: booking_settings.calendar_feed_token — the secret in the owner's private subscribe link
--      (/api/bookings/calendar.ics?t=…). Reset it and every old link stops working.
-- IN:  the private iCal address of the business's calendar, or of one person's (bookable_resources),
--      is a SECRET (it reads their whole calendar): it lives in the vault (vault.ts), never in a
--      column. busy_calendar_host is only what to show ("calendar.google.com"); the rest is status.
--      calendar_busy holds the busy times last read (start/end only — no titles, no attendees),
--      replaced in full at every sync. resource_id NULL = the business's own calendar, which blocks
--      appointments for everyone; a person's blocks only them. Tables and classes are never blocked.

BEGIN;

ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS calendar_feed_token TEXT;
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS busy_calendar_host  TEXT;
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS busy_synced_at      TIMESTAMP;
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS busy_sync_error     TEXT;
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS busy_count          INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS booking_settings_feed_token_uq ON booking_settings (calendar_feed_token) WHERE calendar_feed_token IS NOT NULL;

ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS busy_calendar_host TEXT;
ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS busy_synced_at     TIMESTAMP;
ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS busy_sync_error    TEXT;
ALTER TABLE bookable_resources ADD COLUMN IF NOT EXISTS busy_count         INTEGER;

CREATE TABLE IF NOT EXISTS calendar_busy (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    resource_id      INTEGER REFERENCES bookable_resources(id) ON DELETE CASCADE,
    starts_at        TIMESTAMPTZ NOT NULL,
    ends_at          TIMESTAMPTZ NOT NULL,
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS calendar_busy_org_time_idx ON calendar_busy (organisation_id, starts_at);

COMMIT;
