-- db/z-bookings.sql — bookings, phase 1 (the Website Assistant's booking section).
-- docs/booking-plan.md. Code: src/utils/booking-*.ts, src/utils/bookings.ts,
-- netlify/functions/booking-settings.ts (Business Information), site-serve.ts (/_book), sites.ts.
-- Drizzle mirror: db/schema.ts (bookingSettings, bookableResources, bookings).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-bookings.sql                              (staging)
--   npm run db:migrate:apply -- --only z-bookings.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── booking_settings (one per workspace) ───────────────────────────────────
-- The business's OPENING HOURS live here too — Business Information ▸ Opening hours & bookings —
-- because they are the business's, not a widget's: the booking section, and later an "Open now"
-- badge, all read the same hours. weekly_hours = {"mon":[{"start":"09:00","end":"17:00"}],…} in the
-- business's own timezone; closures = [{"date":"2026-12-25","note":"Christmas"}].
-- Services (and their duration and price) are Business Information products (org_products).
--
-- ── bookable_resources ─────────────────────────────────────────────────────
-- Who or what is booked: a member of staff, a table or seating area (capacity = seats), a room. Own
-- weekly_hours, or NULL = the business's hours. service_ids NULL = can do every service.
--
-- ── bookings ───────────────────────────────────────────────────────────────
-- A customer's booking. starts_at/ends_at are UTC. status: pending (waiting for the owner, in
-- "request" mode) | confirmed | declined | cancelled. A slot is held by pending AND confirmed
-- bookings; creating one re-checks availability under a per-workspace advisory lock (bookings.ts),
-- so two people cannot take the same slot.

BEGIN;

CREATE TABLE IF NOT EXISTS booking_settings (
    id                     SERIAL PRIMARY KEY,
    organisation_id        INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    timezone               TEXT NOT NULL DEFAULT 'Europe/London',
    weekly_hours           JSONB NOT NULL DEFAULT '{}'::jsonb,
    closures               JSONB NOT NULL DEFAULT '[]'::jsonb,
    mode                   TEXT NOT NULL DEFAULT 'request' CHECK (mode IN ('instant', 'request')),
    min_notice_minutes     INTEGER NOT NULL DEFAULT 120,
    max_advance_days       INTEGER NOT NULL DEFAULT 60,
    slot_interval_minutes  INTEGER NOT NULL DEFAULT 30,
    buffer_minutes         INTEGER NOT NULL DEFAULT 0,
    table_minutes          INTEGER NOT NULL DEFAULT 90,
    max_party_size         INTEGER NOT NULL DEFAULT 8,
    cancellation_policy    TEXT,
    updated_at             TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_settings_org_uq ON booking_settings (organisation_id);

CREATE TABLE IF NOT EXISTS bookable_resources (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff', 'table', 'room', 'other')),
    capacity         INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 500),
    weekly_hours     JSONB,
    service_ids      JSONB,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookable_resources_org_idx ON bookable_resources (organisation_id, status, sort_order);

CREATE TABLE IF NOT EXISTS bookings (
    id                SERIAL PRIMARY KEY,
    organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    site_id           INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    service_id        INTEGER REFERENCES org_products(id) ON DELETE SET NULL,
    resource_id       INTEGER REFERENCES bookable_resources(id) ON DELETE SET NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('appointment', 'consultation', 'table')),
    starts_at         TIMESTAMPTZ NOT NULL,
    ends_at           TIMESTAMPTZ NOT NULL,
    party_size        INTEGER NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 500),
    customer_name     TEXT NOT NULL,
    customer_email    TEXT NOT NULL,
    customer_phone    TEXT,
    notes             TEXT,
    service_name      TEXT,
    resource_name     TEXT,
    status            TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled')),
    created_at        TIMESTAMP NOT NULL DEFAULT now(),
    decided_at        TIMESTAMP,
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS bookings_org_time_idx ON bookings (organisation_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_resource_time_idx ON bookings (resource_id, starts_at) WHERE status IN ('pending', 'confirmed');

COMMIT;
