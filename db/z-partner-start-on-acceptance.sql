-- db/z-partner-start-on-acceptance.sql — a partnership starts when the partner ACCEPTS the Partner Terms after an
-- admin approves them (owner, 2026-11-24). Until then: no "Partner since" date, no activity clock, no special-rate dates.
-- Logic: src/utils/partner-start.ts. Drizzle mirror: db/schema.ts (partnerPendingRates).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-partner-start-on-acceptance.sql                              (staging)
--   npm run db:migrate:apply -- --only z-partner-start-on-acceptance.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql and db/z-partner-activity.sql first.
--
--   partner_pending_rates   a special rate an admin has agreed with a partner, with NO dates yet. When the partner
--                           accepts the terms (after approval) it becomes a partner_rate_periods row starting that day
--                           and ending window_months later, and this row is deleted. One per partner.

BEGIN;

CREATE TABLE IF NOT EXISTS partner_pending_rates (
    partner_id          INTEGER PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
    rate_bps            INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
    cost_deduction_bps  INTEGER NOT NULL DEFAULT 2000 CHECK (cost_deduction_bps BETWEEN 0 AND 10000),
    duration_months     INTEGER CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 120),
    window_months       INTEGER NOT NULL DEFAULT 12 CHECK (window_months BETWEEN 1 AND 60),
    label               TEXT,
    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT now()
);

COMMIT;

-- Check: SELECT to_regclass('partner_pending_rates');  → partner_pending_rates
