-- db/z-email-delivery-events.sql — what Resend did with OUR transactional mail (login links,
-- verification, notifications) after it accepted it.
-- Code: src/utils/email-delivery.ts (writes + summaries), netlify/functions/newsletter-webhook.ts
-- (records events that match no newsletter/campaign send), netlify/functions/admin-api.ts
-- (user panel + Users → Email delivery problems). Drizzle mirror: db/schema.ts (emailDeliveryEvents).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Safe to deploy before or after: every reader
-- and the webhook writer catch a missing table, so the only effect of running the code first is that
-- events are not recorded yet.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-email-delivery-events                              (staging)
--   npm run db:migrate:apply -- --only z-email-delivery-events --url-var DATABASE_URL_PROD  (prod)
--
-- Why it exists (2026-10-20): Resend had a user's address on its suppression list. Resend ACCEPTS a
-- send to a suppressed address and then silently drops it, so the send call succeeded, nothing was
-- logged, and the user received no login links or notifications for weeks. The only record was in the
-- Resend dashboard.
--
-- One row per (message, event). Webhook retries carry the same message id + event, so the unique index
-- makes them no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS email_delivery_events (
    id                   SERIAL PRIMARY KEY,
    email                TEXT NOT NULL,
    event_type           TEXT NOT NULL CHECK (event_type IN ('delivered', 'bounced', 'soft_bounced', 'complained', 'suppressed', 'failed')),
    provider_message_id  TEXT NOT NULL,
    subject              TEXT,
    reason               TEXT,
    occurred_at          TIMESTAMP NOT NULL,
    created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_delivery_events_message_event_unique
    ON email_delivery_events (provider_message_id, event_type);
CREATE INDEX IF NOT EXISTS email_delivery_events_email_idx
    ON email_delivery_events (email, occurred_at DESC);
CREATE INDEX IF NOT EXISTS email_delivery_events_occurred_idx
    ON email_delivery_events (occurred_at DESC);

COMMIT;
