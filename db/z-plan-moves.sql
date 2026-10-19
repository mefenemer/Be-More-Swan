-- db/z-plan-moves.sql — Admin → Revenue → Plan moves: customers moved between plans in bulk.
-- Code: netlify/functions/admin-plan-moves.ts, src/utils/plan-change-schedule.ts,
-- netlify/functions/stripe-webhook.ts (finishes a move when it starts). Drizzle mirror: db/schema.ts (planMoves).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-plan-moves                              (staging)
--   npm run db:migrate:apply -- --only z-plan-moves --url-var DATABASE_URL_PROD  (prod)
--
-- ORDER: the Plan moves screen cannot list, preview or run until this exists. The webhook reads it
-- only for a subscription whose new phase carries a planMoveId, which only this screen writes.
--
-- One row per customer per move (owner decisions 2026-10-19): every move starts at the customer's
-- next renewal; a price rise starts no sooner than 30 days after it was scheduled; every customer is
-- emailed (plan_move_scheduled), coupon included. The Stripe subscription schedule does the switch;
-- this row is our record of who moved, from what to what, when, and by whom. Customers the preview
-- skips (free beta/trial, cancelling, overdue, already changing) never get a row.
-- At most ONE scheduled move per workspace (partial unique index), so two batches cannot fight over
-- the same subscription.

BEGIN;

CREATE TABLE IF NOT EXISTS plan_moves (
    id                      SERIAL PRIMARY KEY,
    batch_id                TEXT NOT NULL,
    organisation_id         INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    plan_id                 INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    from_master_plan_id     INTEGER REFERENCES master_plans(id) ON DELETE SET NULL,
    to_master_plan_id       INTEGER NOT NULL REFERENCES master_plans(id),
    from_amount_pence       INTEGER,
    to_amount_pence         INTEGER NOT NULL,
    billing_interval        TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
    direction               TEXT NOT NULL CHECK (direction IN ('up', 'down', 'same')),
    effective_at            TIMESTAMP NOT NULL,
    stripe_subscription_id  TEXT NOT NULL,
    stripe_schedule_id      TEXT,
    status                  TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'applied', 'cancelled', 'failed')),
    error                   TEXT,
    discount_line           TEXT,
    email_sent_at           TIMESTAMP,
    livemode                BOOLEAN NOT NULL,
    created_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancelled_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMP NOT NULL DEFAULT now(),
    updated_at              TIMESTAMP NOT NULL DEFAULT now(),
    applied_at              TIMESTAMP,
    cancelled_at            TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS plan_moves_one_scheduled_per_org
    ON plan_moves (organisation_id) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS plan_moves_batch_idx ON plan_moves (batch_id);
CREATE INDEX IF NOT EXISTS plan_moves_subscription_idx ON plan_moves (stripe_subscription_id);

COMMIT;
