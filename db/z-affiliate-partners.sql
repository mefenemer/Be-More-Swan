-- db/z-affiliate-partners.sql — Affiliate Partner Programme, step 1: the tables.
-- Plan: docs/affiliate-partner-programme-plan.md. Drizzle mirror: db/schema.ts (partner* tables).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-affiliate-partners.sql                              (staging)
--   npm run db:migrate:apply -- --only z-affiliate-partners.sql --url-var DATABASE_URL_PROD  (prod)
--
-- Two tracks, kept apart: ordinary customers who refer a friend stay on user_referrals + the token
-- vault, untouched. Approved PARTNERS earn cash. Nothing here alters user_referrals — the partner
-- side of a referral lives in partner_referrals, so no existing read of user_referrals can break
-- while this file is pending.
--
-- Money is integer pence; rates are integer basis points (2500 = 25%) — never numeric, which
-- postgres-js returns as a string.
--
-- Rates are DATED PERIODS (partner_rate_periods). A partner's referred customer gets the rate of
-- the period covering the moment they FIRST PAY, copied onto partner_referrals and kept for their
-- whole commission window. A partner-specific period beats the programme-wide one. Enforced in
-- src/utils/partner-rate-periods.ts, not here: no overlaps per scope, no gaps in programme-wide
-- periods, and a started period's rate/duration are frozen (only its end date may move).
--
-- Financial history outlives people: deleting a user nulls partners.user_id rather than deleting
-- the partner and its ledger (HMRC wants six years of payment records).

BEGIN;

-- Non-rate programme settings. Exactly one row.
CREATE TABLE IF NOT EXISTS partner_programme_settings (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    holding_days      INTEGER NOT NULL DEFAULT 30 CHECK (holding_days BETWEEN 0 AND 365),
    min_payout_pence  INTEGER NOT NULL DEFAULT 5000 CHECK (min_payout_pence >= 0),
    currency          TEXT NOT NULL DEFAULT 'GBP' CHECK (currency IN ('GBP')),
    updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at        TIMESTAMP NOT NULL DEFAULT now()
);
INSERT INTO partner_programme_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One per person. Applied → approved by an admin. Payout details are encrypted
-- (src/utils/encryption.ts encryptCredential) and changes need an email confirmation.
CREATE TABLE IF NOT EXISTS partners (
    id                     SERIAL PRIMARY KEY,
    user_id                INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    status                 TEXT NOT NULL DEFAULT 'applied'
                           CHECK (status IN ('applied', 'approved', 'rejected', 'suspended')),
    application            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- how they'll promote, audience, links
    stripe_coupon_id       TEXT,                                 -- optional personal promo code (admin turns on)
    stripe_promo_code_id   TEXT UNIQUE,
    payout_method          TEXT CHECK (payout_method IN ('wise', 'paypal', 'bank')),
    payout_details_enc     TEXT,
    payout_details_confirmed_at TIMESTAMP,
    vat_registered         BOOLEAN NOT NULL DEFAULT false,
    vat_number             TEXT,
    decided_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at             TIMESTAMP,
    decision_note          TEXT,
    created_at             TIMESTAMP NOT NULL DEFAULT now(),
    updated_at             TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partners_status_idx ON partners (status, created_at DESC);

-- Commission rates over time. partner_id NULL = programme-wide; set = that partner only.
-- ends_at NULL = open-ended. duration_months NULL = lifetime.
CREATE TABLE IF NOT EXISTS partner_rate_periods (
    id               SERIAL PRIMARY KEY,
    partner_id       INTEGER REFERENCES partners(id) ON DELETE CASCADE,
    rate_bps         INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
    duration_months  INTEGER CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 120),
    starts_at        TIMESTAMP NOT NULL,
    ends_at          TIMESTAMP,
    label            TEXT,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT partner_rate_periods_range_check CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_rate_periods_scope_start_uq
    ON partner_rate_periods (COALESCE(partner_id, 0), starts_at);
CREATE INDEX IF NOT EXISTS partner_rate_periods_partner_idx ON partner_rate_periods (partner_id, starts_at);

-- The launch default (25% for each customer's first 12 months, open-ended), only on a fresh table.
INSERT INTO partner_rate_periods (partner_id, rate_bps, duration_months, starts_at, label)
SELECT NULL, 2500, 12, TIMESTAMP '2026-10-18 00:00:00', 'Launch rate'
WHERE NOT EXISTS (SELECT 1 FROM partner_rate_periods WHERE partner_id IS NULL);

-- The partner side of a user_referrals row. Written at sign-up (source); the terms are LOCKED at
-- the customer's first payment that takes money — copied, not just linked, so editing a period
-- later can never change what was promised.
CREATE TABLE IF NOT EXISTS partner_referrals (
    id               SERIAL PRIMARY KEY,
    referral_id      INTEGER NOT NULL UNIQUE REFERENCES user_referrals(id) ON DELETE CASCADE,
    partner_id       INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
    source           TEXT NOT NULL DEFAULT 'link' CHECK (source IN ('link', 'promo_code', 'manual')),
    subscribed_at    TIMESTAMP,
    rate_period_id   INTEGER REFERENCES partner_rate_periods(id) ON DELETE SET NULL,
    rate_bps         INTEGER CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
    duration_months  INTEGER,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT partner_referrals_locked_check CHECK ((subscribed_at IS NULL) = (rate_bps IS NULL))
);
CREATE INDEX IF NOT EXISTS partner_referrals_partner_idx ON partner_referrals (partner_id, created_at DESC);

-- A monthly payout run: payable balances ≥ minimum → Wise CSV → marked paid.
CREATE TABLE IF NOT EXISTS partner_payout_batches (
    id             SERIAL PRIMARY KEY,
    status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'exported', 'paid', 'cancelled')),
    currency       TEXT NOT NULL DEFAULT 'GBP',
    total_pence    INTEGER NOT NULL DEFAULT 0,
    partner_count  INTEGER NOT NULL DEFAULT 0,
    note           TEXT,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT now(),
    exported_at    TIMESTAMP,
    paid_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    paid_at        TIMESTAMP
);

-- The ledger. kind 'invoice' = earned on a customer payment (one row per Stripe invoice — the
-- partial unique index makes a retried webhook a no-op); 'bonus' = admin goodwill; 'adjustment'
-- = negative carry-forward when an already-paid commission is refunded.
CREATE TABLE IF NOT EXISTS partner_commissions (
    id                   SERIAL PRIMARY KEY,
    partner_id           INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
    partner_referral_id  INTEGER REFERENCES partner_referrals(id) ON DELETE SET NULL,
    kind                 TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'bonus', 'adjustment')),
    stripe_invoice_id    TEXT,
    stripe_charge_id     TEXT,
    net_amount_pence     INTEGER,                       -- customer payment excl. VAT ('invoice' only)
    rate_bps             INTEGER,                       -- snapshot of the rate used ('invoice' only)
    commission_pence     INTEGER NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'GBP',
    status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'payable', 'paid', 'voided')),
    available_at         TIMESTAMP NOT NULL,            -- end of the holding period
    payout_batch_id      INTEGER REFERENCES partner_payout_batches(id) ON DELETE SET NULL,
    paid_at              TIMESTAMP,
    voided_at            TIMESTAMP,
    void_reason          TEXT,
    note                 TEXT,
    created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- admin, for bonus/adjustment
    created_at           TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT partner_commissions_invoice_check CHECK (
        kind <> 'invoice' OR (stripe_invoice_id IS NOT NULL AND net_amount_pence IS NOT NULL
                              AND rate_bps IS NOT NULL AND commission_pence >= 0)
    ),
    CONSTRAINT partner_commissions_sign_check CHECK (
        (kind = 'adjustment' AND commission_pence < 0) OR (kind <> 'adjustment' AND commission_pence >= 0)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_commissions_invoice_uq
    ON partner_commissions (stripe_invoice_id) WHERE kind = 'invoice';
CREATE INDEX IF NOT EXISTS partner_commissions_partner_idx ON partner_commissions (partner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_commissions_due_idx ON partner_commissions (status, available_at);
CREATE INDEX IF NOT EXISTS partner_commissions_charge_idx ON partner_commissions (stripe_charge_id);
CREATE INDEX IF NOT EXISTS partner_commissions_batch_idx ON partner_commissions (payout_batch_id);

-- Clicks on /invite/<code>, counted on the server per partner per day. No IP, nothing on the
-- visitor's device.
CREATE TABLE IF NOT EXISTS partner_link_stats (
    partner_id  INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    day         DATE NOT NULL,
    clicks      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (partner_id, day)
);

COMMIT;
