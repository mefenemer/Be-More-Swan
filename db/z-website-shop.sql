-- db/z-website-shop.sql — the Website Assistant, step 3c: selling on hosted sites (decision D4).
-- docs/website-assistant-plan.md §5.4. Code: src/utils/site-shop.ts, netlify/functions/site-serve.ts
-- (/_buy), netlify/functions/stripe-connect-webhook.ts, netlify/functions/sites.ts (payments_*).
-- Drizzle mirror: db/schema.ts (stripeConnectAccounts, siteOrders).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-website-shop.sql                              (staging)
--   npm run db:migrate:apply -- --only z-website-shop.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── stripe_connect_accounts ────────────────────────────────────────────────
-- One Stripe STANDARD account per workspace: the business is the merchant of record (their
-- refunds, disputes, VAT); the money goes straight to them; we take NO fee (decision D5: 0%).
-- The flags mirror Stripe's and are refreshed on return from onboarding and by account.updated.
-- A site sells only while charges_enabled is true.
--
-- ── site_orders ────────────────────────────────────────────────────────────
-- A paid Checkout Session on that account, recorded from the Connect webhook. checkout_session_id
-- is unique: Stripe retries webhooks, and a retry must not record a second order.

BEGIN;

CREATE TABLE IF NOT EXISTS stripe_connect_accounts (
    id                  SERIAL PRIMARY KEY,
    organisation_id     INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    stripe_account_id   TEXT NOT NULL,
    livemode            BOOLEAN NOT NULL DEFAULT true,
    charges_enabled     BOOLEAN NOT NULL DEFAULT false,
    details_submitted   BOOLEAN NOT NULL DEFAULT false,
    payouts_enabled     BOOLEAN NOT NULL DEFAULT false,
    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_accounts_org_uq ON stripe_connect_accounts (organisation_id);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_connect_accounts_acct_uq ON stripe_connect_accounts (stripe_account_id);

CREATE TABLE IF NOT EXISTS site_orders (
    id                    SERIAL PRIMARY KEY,
    site_id               INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    stripe_account_id     TEXT NOT NULL,
    checkout_session_id   TEXT NOT NULL,
    item_name             TEXT NOT NULL,
    quantity              INTEGER NOT NULL DEFAULT 1,
    amount_total          INTEGER NOT NULL,
    currency              TEXT NOT NULL,
    customer_name         TEXT,
    customer_email        TEXT,
    shipping_address      JSONB,
    page_path             TEXT,
    status                TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'done')),
    created_at            TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS site_orders_session_uq ON site_orders (checkout_session_id);
CREATE INDEX IF NOT EXISTS site_orders_site_idx ON site_orders (site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS site_orders_org_idx ON site_orders (organisation_id);

COMMIT;
