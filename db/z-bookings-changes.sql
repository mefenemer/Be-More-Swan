-- db/z-bookings-changes.sql — bookings, phase 2 (docs/booking-plan.md): customers cancel or move their
-- own booking from a signed link, and get a reminder the day before.
-- Code: src/utils/booking-links.ts, src/utils/bookings.ts, src/utils/site-booking.ts,
-- netlify/functions/send-booking-reminders.ts. Drizzle mirror: db/schema.ts (bookings).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-bookings-changes.sql                              (staging)
--   npm run db:migrate:apply -- --only z-bookings-changes.sql --url-var DATABASE_URL_PROD  (prod)
--
-- cancelled_by      'owner' | 'customer' — who cancelled (the owner's list says which)
-- moved_from_id     on a booking made by MOVING another: the booking it replaced (cancelled_by 'customer')
-- reminder_sent_at  the day-before reminder went out (sent once; the hourly job skips it after)

BEGIN;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by      TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS moved_from_id     INTEGER REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent_at  TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancelled_by_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_cancelled_by_check CHECK (cancelled_by IS NULL OR cancelled_by IN ('owner', 'customer'));
  END IF;
END $$;

-- The reminder job's query: confirmed bookings starting soon that have not been reminded.
CREATE INDEX IF NOT EXISTS bookings_reminder_due_idx ON bookings (starts_at) WHERE status = 'confirmed' AND reminder_sent_at IS NULL;

COMMIT;
