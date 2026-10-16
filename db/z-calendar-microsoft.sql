-- db/z-calendar-microsoft.sql — the Outlook / Microsoft 365 calendar, signed in (docs/booking-plan.md
-- phase 3, the optional faster upgrade). Code: src/utils/calendar-microsoft.ts; the connection is a
-- workspace integration, provider 'outlook_calendar' (oauth-integrations.ts, same Azure app as
-- Outlook email). Drizzle mirror: db/schema.ts (calendarEvents, bookingSettings.busySource).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-calendar-microsoft.sql                              (staging)
--   npm run db:migrate:apply -- --only z-calendar-microsoft.sql --url-var DATABASE_URL_PROD  (prod)
--
-- calendar_events: which event in the owner's calendar is which booking or class date
--   (item_key 'b:<booking id>' | 's:<session id>'), and a hash of what was written, so the
--   reconciler only creates, changes or deletes what differs. Our events carry the transactionId
--   'bms-<org>-<item_key>' too, so they are never read back as busy times.
-- booking_settings.busy_source: where the business's own busy times come from — 'ical' (the private
--   address) or 'microsoft' (the signed-in calendar). NULL = none.

CREATE TABLE IF NOT EXISTS calendar_events (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    provider         TEXT NOT NULL DEFAULT 'microsoft',
    item_key         TEXT NOT NULL,
    external_id      TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    ends_at          TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_org_item_uq ON calendar_events (organisation_id, provider, item_key);

ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS busy_source TEXT;
