-- db/z-review-requests.sql — asking customers for a review (Business Information ▸ Reviews).
-- src/utils/review-requests.ts, netlify/functions/send-review-requests.ts (hourly), site-review.ts
-- (the page on the business's own site), org-reviews.ts (settings + approving).
-- Drizzle mirror: db/schema.ts (reviewSettings, reviewRequests, reviewOptOuts).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-review-requests.sql                              (staging)
--   npm run db:migrate:apply -- --only z-review-requests.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── review_settings (one per workspace) ─────────────────────────────────────
-- OFF by default. When on, a customer is emailed ONCE, a set time after a confirmed booking ends or
-- after a paid website order — only for bookings / orders after the moment it was switched on
-- (enabled_at), never a back-catalogue. google_review_url: their Google "write a review" link,
-- offered to EVERY customer alike (Google forbids sending only happy customers there).
--
-- ── review_requests ─────────────────────────────────────────────────────────
-- One row per booking or order asked about (unique), claimed BEFORE the email is sent so two runs
-- cannot both send. skipped_reason when no email went (opted out, asked recently). review_id once
-- they answer; the review itself is org_reviews with status 'pending' until the owner approves.
--
-- ── review_opt_outs ─────────────────────────────────────────────────────────
-- "Don't ask me for reviews again", per workspace, by a hash of the email address.

BEGIN;

CREATE TABLE IF NOT EXISTS review_settings (
    id                   SERIAL PRIMARY KEY,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ask_after_bookings   BOOLEAN NOT NULL DEFAULT false,
    ask_after_orders     BOOLEAN NOT NULL DEFAULT false,
    booking_delay_hours  INTEGER NOT NULL DEFAULT 24 CHECK (booking_delay_hours BETWEEN 1 AND 336),
    order_delay_days     INTEGER NOT NULL DEFAULT 7 CHECK (order_delay_days BETWEEN 1 AND 30),
    google_review_url    TEXT,
    enabled_at           TIMESTAMP,
    updated_at           TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS review_settings_org_uq ON review_settings (organisation_id);

CREATE TABLE IF NOT EXISTS review_requests (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    site_id          INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    booking_id       INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    order_id         INTEGER REFERENCES site_orders(id) ON DELETE SET NULL,
    customer_name    TEXT,
    customer_email   TEXT NOT NULL,
    about            TEXT,
    sent_at          TIMESTAMP,
    skipped_reason   TEXT,
    responded_at     TIMESTAMP,
    review_id        INTEGER REFERENCES org_reviews(id) ON DELETE SET NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_booking_uq ON review_requests (booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_order_uq ON review_requests (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_requests_org_email_idx ON review_requests (organisation_id, lower(customer_email), sent_at);

CREATE TABLE IF NOT EXISTS review_opt_outs (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    email_key        TEXT NOT NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS review_opt_outs_org_email_uq ON review_opt_outs (organisation_id, email_key);

COMMIT;
