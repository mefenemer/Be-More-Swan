-- db/z-feature-go-live-hold.sql — "Switched off until approval": hold a feature request at In Progress
-- even though its code is in production (owner, 2026-11-13; src/utils/feature-proof.ts).
--
-- The go-live check moves a request to Released once the production deploy contains it. Some features ship
-- switched off (LinkedIn Company Page until LinkedIn approves, Google Calendar until Google approves, the
-- Email Assistant while it is in beta). While go_live_hold is set the check leaves the request alone and the
-- checklist says why; Claude clears it (scripts/feature-requests.ts unhold) only when the owner switches the
-- feature on.
--
--   go_live_hold     why it is held, in plain words (NULL = not held)
--   go_live_hold_at  when it was held
--
-- Not declared in db/schema.ts; read raw behind featureHoldColumnReady(). Additive and idempotent: run on BOTH DBs.

BEGIN;

ALTER TABLE feature_requests
    ADD COLUMN IF NOT EXISTS go_live_hold TEXT,
    ADD COLUMN IF NOT EXISTS go_live_hold_at TIMESTAMP;

COMMIT;

-- Check (expect 2):
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_name = 'feature_requests' AND column_name IN ('go_live_hold', 'go_live_hold_at');
