-- Security & Fair Usage — Multi-Account Abuse Prevention (US3: Stripe Fingerprint Monitoring).
-- Records the Stripe card fingerprint (a stable hash of the physical card, NOT the PAN) on each
-- workspace, and a flag raised when the same fingerprint is active on two or more workspaces.
--
-- APPLY MANUALLY (Neon SQL editor / psql as owner) — do NOT use `drizzle-kit push`. Idempotent.

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS card_fingerprint        text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS billing_review_required boolean NOT NULL DEFAULT false;

-- Fast lookup of all workspaces sharing a fingerprint (collision detection + dashboard grouping).
CREATE INDEX IF NOT EXISTS organisations_card_fingerprint_idx
  ON organisations (card_fingerprint) WHERE card_fingerprint IS NOT NULL;
