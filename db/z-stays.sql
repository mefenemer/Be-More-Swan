-- db/z-stays.sql — holiday lets and B&B rooms, phase 1 (docs/holiday-lets-plan.md).
-- Code: src/utils/stay-quote.ts, stay-availability.ts, stay-clean.ts, stays.ts. Drizzle mirror: db/schema.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-stays.sql                              (staging)
--   npm run db:migrate:apply -- --only z-stays.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── stay_types ─────────────────────────────────────────────────────────────
-- What a guest books. stay_type 'whole' = a whole property (cottage, flat) with ONE unit, made for it;
-- 'room' = a B&B room type ("Double with sea view") with one or more named units (Room 3, Room 5).
-- Kept apart from bookable_resources on purpose: every appointment reader treats any non-table
-- resource as staff, so a property there would be offered as a hairdresser.
-- Money in minor units of `currency`. arrival_details (door code, Wi-Fi) is NEVER shown on the site;
-- it is emailed only. cancellation = [{"days":28,"refund":100},{"days":14,"refund":50}] (days before
-- check-in → % refunded; fewer days than the smallest = no refund).
--
-- ── stay_rates / stay_fees ─────────────────────────────────────────────────
-- A rate with starts_on/ends_on NULL is the base rate; a season covers nights starts_on..ends_on
-- (inclusive, the NIGHT's date). changeover_days = ["sat"] (check-in weekdays), NULL = any day.
-- Fee per: stay (once per room booked) | night (per room per night) | guest_night (per guest per night).
-- extra_guest is charged per guest above after_guests per room. optional = the guest chooses it
-- (pets, breakfast when the room type's breakfast is 'optional').
--
-- ── stay_units / stay_blocks / booking_units ───────────────────────────────
-- A unit is the actual house or room. A booking holds one unit (per room booked) for the WHOLE stay
-- in booking_units; check_out is exclusive (the departure morning is free for the next guest, unless
-- gap_nights says otherwise). stay_blocks = dates the owner closed (own use, repairs), check_out-style.
--
-- ── bookings ───────────────────────────────────────────────────────────────
-- kind 'stay'. starts_at/ends_at = check-in time on arrival day → check-out time on departure day, so
-- existing readers (calendar feed, Outlook, reminders) keep working; availability uses the DATES.
-- party_size = guests. quote = the lines as charged. deposit_pence (existing) = what is due at
-- booking; balance_* = the rest; damage_deposit_* = the refundable damage deposit.

BEGIN;

CREATE TABLE IF NOT EXISTS stay_types (
    id                          SERIAL PRIMARY KEY,
    organisation_id             INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    stay_type                   TEXT NOT NULL DEFAULT 'whole' CHECK (stay_type IN ('whole', 'room')),
    name                        TEXT NOT NULL,
    slug                        TEXT NOT NULL,
    summary                     TEXT,
    description                 TEXT,
    max_guests                  INTEGER NOT NULL DEFAULT 2 CHECK (max_guests BETWEEN 1 AND 50),
    bedrooms                    INTEGER CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 50),
    bathrooms                   INTEGER CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 50),
    beds                        TEXT,
    amenities                   JSONB NOT NULL DEFAULT '[]'::jsonb,
    house_rules                 TEXT,
    address                     TEXT,
    licence_number              TEXT,
    images                      JSONB NOT NULL DEFAULT '[]'::jsonb,
    check_in_time               TEXT NOT NULL DEFAULT '16:00' CHECK (check_in_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
    check_out_time              TEXT NOT NULL DEFAULT '10:00' CHECK (check_out_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
    mode                        TEXT NOT NULL DEFAULT 'request' CHECK (mode IN ('instant', 'request')),
    arrival_details             TEXT,
    arrival_details_days        INTEGER NOT NULL DEFAULT 3 CHECK (arrival_details_days BETWEEN 0 AND 30),
    breakfast                   TEXT NOT NULL DEFAULT 'none' CHECK (breakfast IN ('none', 'included', 'optional')),
    single_discount             INTEGER CHECK (single_discount IS NULL OR single_discount BETWEEN 0 AND 100000000),
    currency                    TEXT NOT NULL DEFAULT 'GBP' CHECK (currency IN ('GBP', 'USD', 'EUR', 'AUD', 'CAD')),
    deposit_percent             INTEGER NOT NULL DEFAULT 0 CHECK (deposit_percent BETWEEN 0 AND 100),
    balance_days                INTEGER NOT NULL DEFAULT 28 CHECK (balance_days BETWEEN 0 AND 365),
    balance_collection          TEXT NOT NULL DEFAULT 'link' CHECK (balance_collection IN ('auto', 'link')),
    damage_deposit              INTEGER CHECK (damage_deposit IS NULL OR damage_deposit BETWEEN 100 AND 100000000),
    damage_deposit_return_days  INTEGER NOT NULL DEFAULT 7 CHECK (damage_deposit_return_days BETWEEN 1 AND 30),
    cancellation                JSONB NOT NULL DEFAULT '[]'::jsonb,
    min_notice_days             INTEGER NOT NULL DEFAULT 1 CHECK (min_notice_days BETWEEN 0 AND 60),
    max_advance_days            INTEGER NOT NULL DEFAULT 540 CHECK (max_advance_days BETWEEN 1 AND 1095),
    gap_nights                  INTEGER NOT NULL DEFAULT 0 CHECK (gap_nights BETWEEN 0 AND 7),
    status                      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    sort_order                  INTEGER NOT NULL DEFAULT 0,
    created_at                  TIMESTAMP NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stay_types_org_slug_uq ON stay_types (organisation_id, slug);
CREATE INDEX IF NOT EXISTS stay_types_org_idx ON stay_types (organisation_id, status, sort_order);

CREATE TABLE IF NOT EXISTS stay_rates (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    stay_type_id     INTEGER NOT NULL REFERENCES stay_types(id) ON DELETE CASCADE,
    name             TEXT NOT NULL DEFAULT 'Standard',
    starts_on        DATE,
    ends_on          DATE,
    nightly          INTEGER NOT NULL CHECK (nightly BETWEEN 0 AND 100000000),
    weekend_nightly  INTEGER CHECK (weekend_nightly IS NULL OR weekend_nightly BETWEEN 0 AND 100000000),
    weekly_nightly   INTEGER CHECK (weekly_nightly IS NULL OR weekly_nightly BETWEEN 0 AND 100000000),
    min_nights       INTEGER NOT NULL DEFAULT 1 CHECK (min_nights BETWEEN 1 AND 60),
    changeover_days  JSONB,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    CHECK ((starts_on IS NULL) = (ends_on IS NULL)),
    CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS stay_rates_type_idx ON stay_rates (stay_type_id);

CREATE TABLE IF NOT EXISTS stay_fees (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    stay_type_id     INTEGER NOT NULL REFERENCES stay_types(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('cleaning', 'pet', 'extra_guest', 'breakfast', 'other')),
    label            TEXT NOT NULL,
    amount           INTEGER NOT NULL CHECK (amount BETWEEN 0 AND 100000000),
    per              TEXT NOT NULL DEFAULT 'stay' CHECK (per IN ('stay', 'night', 'guest_night')),
    after_guests     INTEGER CHECK (after_guests IS NULL OR after_guests BETWEEN 0 AND 50),
    optional         BOOLEAN NOT NULL DEFAULT false,
    sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stay_fees_type_idx ON stay_fees (stay_type_id);

CREATE TABLE IF NOT EXISTS stay_units (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    stay_type_id     INTEGER NOT NULL REFERENCES stay_types(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stay_units_type_idx ON stay_units (stay_type_id, status, sort_order);

CREATE TABLE IF NOT EXISTS stay_blocks (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    unit_id          INTEGER NOT NULL REFERENCES stay_units(id) ON DELETE CASCADE,
    starts_on        DATE NOT NULL,
    ends_on          DATE NOT NULL,
    note             TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    CHECK (ends_on > starts_on)
);
CREATE INDEX IF NOT EXISTS stay_blocks_unit_idx ON stay_blocks (unit_id, starts_on);

-- bookings: the 'stay' kind and its columns.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stay_type_id                INTEGER REFERENCES stay_types(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS check_in                    DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS check_out                   DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rooms                       INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS quote                       JSONB;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS currency                    TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_pence               INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_status              TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_due_on              DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_collection          TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_customer_id          TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method_id           TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_deposit_pence        INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_deposit_status       TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_deposit_kept_pence   INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_deposit_kept_reason  TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_deposit_return_on    DATE;
-- Collecting the balance and giving the damage deposit back (stay-jobs.ts). Which Stripe payment each
-- part arrived in (a refund goes back on the payment that took it), and when each email went.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_payment_intent_id   TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_checkout_session_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_requested_at        TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_reminded_at         TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_owner_told_at       TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_payment_intent_id    TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_reminded_at          TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_decided_at           TIMESTAMPTZ;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_kind_check'
          AND pg_get_constraintdef(oid) LIKE '%stay%'
    ) THEN
        ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_kind_check;
        ALTER TABLE bookings ADD CONSTRAINT bookings_kind_check CHECK (kind IN ('appointment', 'consultation', 'table', 'class', 'stay'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_stay_money_check') THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_stay_money_check CHECK (
            (balance_status IS NULL OR balance_status IN ('none', 'due', 'paid', 'failed', 'refunded'))
            AND (balance_collection IS NULL OR balance_collection IN ('auto', 'link'))
            AND (damage_deposit_status IS NULL OR damage_deposit_status IN ('none', 'due', 'held', 'returned', 'part_kept', 'refund_failed')));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS bookings_balance_due_idx ON bookings (balance_due_on) WHERE balance_status = 'due';
CREATE INDEX IF NOT EXISTS bookings_damage_return_idx ON bookings (damage_deposit_return_on) WHERE damage_deposit_status = 'held';
CREATE UNIQUE INDEX IF NOT EXISTS bookings_balance_session_uq ON bookings (balance_checkout_session_id) WHERE balance_checkout_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS booking_units (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    booking_id       INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    unit_id          INTEGER NOT NULL REFERENCES stay_units(id) ON DELETE CASCADE,
    check_in         DATE NOT NULL,
    check_out        DATE NOT NULL,
    CHECK (check_out > check_in)
);
CREATE INDEX IF NOT EXISTS booking_units_unit_idx ON booking_units (unit_id, check_in);
CREATE INDEX IF NOT EXISTS booking_units_booking_idx ON booking_units (booking_id);

COMMIT;
