-- db/z-loss-reason-undeliverable.sql — add 'undeliverable' ("Couldn't reach them — their email
-- address didn't work") to the closed loss_reason vocabulary on revenue_events (2026-11-03).
--
-- Why: when follow-ups halt with send_failed (src/config/outreach-sequences.ts) because the address
-- bounces, the user has no reason that fits and the lead lands in `other`. Kept apart from
-- `no_response` ("Never replied"): they never got the email, which is a data-quality signal about
-- enrichment, not a judgement on the pitch.
--
-- Same shape as db/z-loss-reason-against-ai.sql, and it restates that file's 'against_ai' so the two
-- can run in either order. A CHECK constraint has no dependants, so drop-then-add is safe to re-run.
--
-- ⚠️ APPLY BEFORE DEPLOYING the code: until it runs, choosing the new reason fails the insert.
--   npm run db:migrate:apply -- --only z-loss-reason-undeliverable                              (staging)
--   npm run db:migrate:apply -- --only z-loss-reason-undeliverable --url-var DATABASE_URL_PROD  (prod)

BEGIN;

ALTER TABLE revenue_events DROP CONSTRAINT IF EXISTS revenue_events_loss_reason_check;
ALTER TABLE revenue_events ADD CONSTRAINT revenue_events_loss_reason_check
  CHECK (loss_reason IS NULL OR loss_reason IN (
    'price','timing','no_budget','competitor','no_response',
    'wrong_contact','not_icp','feature_gap','went_silent','against_ai','undeliverable','other'
  ));

COMMIT;
