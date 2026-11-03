-- db/z-loss-reason-against-ai.sql — add 'against_ai' ("Doesn't want to use AI") to the closed
-- loss_reason vocabulary on revenue_events (2026-11-03).
--
-- Why: leads are replying "AI has decimated my industry, not interested" and no existing reason fits.
-- Recording them as `other` hides the pattern from the Strategy Agent and the Mentor's
-- "lost mostly to" line, which GROUP BY this column.
--
-- db/revenue-events.sql now lists the new value for fresh databases, but its constraint is guarded by
-- IF NOT EXISTS, so existing databases keep the old list until this file runs. Replaces the CHECK in
-- one transaction. A CHECK constraint has no dependants, so drop-then-add is safe to re-run (unlike
-- the unique-key trap in swan-index.sql).
--
-- ⚠️ APPLY BEFORE DEPLOYING the code: until it runs, choosing the new reason fails the insert.
--   npm run db:migrate:apply -- --only z-loss-reason-against-ai                              (staging)
--   npm run db:migrate:apply -- --only z-loss-reason-against-ai --url-var DATABASE_URL_PROD  (prod)

BEGIN;

ALTER TABLE revenue_events DROP CONSTRAINT IF EXISTS revenue_events_loss_reason_check;
ALTER TABLE revenue_events ADD CONSTRAINT revenue_events_loss_reason_check
  CHECK (loss_reason IS NULL OR loss_reason IN (
    'price','timing','no_budget','competitor','no_response',
    'wrong_contact','not_icp','feature_gap','went_silent','against_ai','other'
  ));

COMMIT;
