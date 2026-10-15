-- db/z-classes.sql — bookings phase 5: classes and events (docs/booking-plan.md).
-- Code: src/utils/class-sessions.ts, src/utils/site-classes.ts (/_book for a "class" section),
-- netlify/functions/sites.ts (the Website tab's timetable). Drizzle mirror: db/schema.ts
-- (classSessions, classWaitlist, bookings.sessionId).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-classes.sql                              (staging)
--   npm run db:migrate:apply -- --only z-classes.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── class_sessions ─────────────────────────────────────────────────────────
-- One dated occurrence: a class (a Business Information product — its name, price and description)
-- at a time, optionally with a teacher or room (bookable_resources), for `capacity` places. A weekly
-- class is several sessions sharing a series_key, so one can be cancelled without the rest.
-- status: scheduled | cancelled. Times are instants (UTC), entered in the business's timezone.
--
-- ── bookings.session_id ────────────────────────────────────────────────────
-- A class booking is an ordinary booking (kind 'class', party_size = places), so emails, reminders,
-- the customer's cancel link and review requests all work unchanged. Places are re-counted under the
-- same per-workspace lock as every booking (class-sessions.ts bookSession).
--
-- ── class_waitlist ─────────────────────────────────────────────────────────
-- When a session is full. When places free up, the earliest person whose places fit is emailed a
-- link to book (offered_at) — first come, first served; nothing is held for them.

BEGIN;

CREATE TABLE IF NOT EXISTS class_sessions (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    service_id       INTEGER REFERENCES org_products(id) ON DELETE SET NULL,
    title            TEXT NOT NULL,
    resource_id      INTEGER REFERENCES bookable_resources(id) ON DELETE SET NULL,
    resource_name    TEXT,
    starts_at        TIMESTAMPTZ NOT NULL,
    ends_at          TIMESTAMPTZ NOT NULL,
    capacity         INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 500),
    status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
    series_key       TEXT,
    notes            TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS class_sessions_org_time_idx ON class_sessions (organisation_id, starts_at);
CREATE INDEX IF NOT EXISTS class_sessions_series_idx ON class_sessions (series_key) WHERE series_key IS NOT NULL;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES class_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bookings_session_idx ON bookings (session_id) WHERE session_id IS NOT NULL;

-- Widen the kind check to include 'class'. A CHECK has nothing depending on it, so replacing it is
-- safe to re-run; guarded so a re-run that finds it already widened changes nothing.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_kind_check'
          AND pg_get_constraintdef(oid) LIKE '%class%'
    ) THEN
        ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_kind_check;
        ALTER TABLE bookings ADD CONSTRAINT bookings_kind_check CHECK (kind IN ('appointment', 'consultation', 'table', 'class'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS class_waitlist (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    session_id       INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    email            TEXT NOT NULL,
    places           INTEGER NOT NULL DEFAULT 1 CHECK (places BETWEEN 1 AND 100),
    offered_at       TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS class_waitlist_session_email_uq ON class_waitlist (session_id, lower(email));

COMMIT;
