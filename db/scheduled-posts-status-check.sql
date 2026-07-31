-- db/scheduled-posts-status-check.sql
-- Widen scheduled_posts_status_check to cover every status the application code actually writes.
--
-- Root cause: the original constraint only allowed
--   draft | in_review | approved | scheduled | published | rejected | cancelled | missed
-- but the Social Drafts / publishing pipeline writes additional statuses:
--   - 'pending_approval' : human + AI drafts awaiting review (create-manual-post.ts,
--                          process-content-jobs.ts, autonomous-media-suggestions.ts,
--                          get-social-drafts.ts, approve-post.ts)
--   - 'publishing'       : in-flight publish (publish-social-posts.ts)
--   - 'failed'           : publish failure (publish-social-posts.ts)
--   - 'paused'           : publish pipeline pause (schema extension)
--   - 'admin_test'       : admin dry-run drafts (process-content-jobs.ts)
--
-- Inserting/updating to any of those raised a check-constraint violation. For the
-- synchronous, user-facing create-manual-post.ts this surfaced as a 502 Bad Gateway;
-- for the background jobs it failed silently.
--
-- ── 2026-07-31: 'paused_credits' — this file catching up to the DATABASE, not the other way round ─
--   - 'paused_credits'   : X quota park (publish-social-posts.ts → pauseForXCredits)
--
-- NOT a synonym for 'paused'. pauseForXCredits writes it when either the org's monthly X allowance
-- or the connected X account's own API quota is spent, and TWO sweeps select it back out — the
-- monthly reset at the top of publish-social-posts.ts, and stripe-webhook.ts on a credit-pack
-- purchase. Both match on `status = 'paused_credits' AND platform = 'x'`.
--
-- The live constraint ALREADY allowed it (introspected 2026-07-31); this file, db/schema.ts and
-- src/config/post-status.ts did not. That is the drift direction that hides itself: the writes
-- succeeded, so nothing errored — the rows were simply invisible everywhere downstream, because
-- post-status.ts did not classify the status and so the calendar never selected it. Adding it here
-- is therefore a NO-OP against a database that already matches, and the point of the line is to
-- stop the code drifting away again (tests/schedule-visibility.test.ts parses this file as the
-- canonical status vocabulary).
--
-- ⚠️ Do not infer the live constraint from this file, in either direction. Introspect it:
--
--   SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'scheduled_posts'::regclass AND conname = 'scheduled_posts_status_check';
--
-- This widening is purely additive (it only enlarges the allowed set) so it can never
-- reject an existing row. Idempotent: safe to run repeatedly.
--
-- Apply manually as the table owner (no drizzle-kit push — see project convention).

ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_status_check;

ALTER TABLE scheduled_posts
  ADD CONSTRAINT scheduled_posts_status_check
  CHECK (status IN (
    'draft',
    'pending_approval',
    'in_review',
    'approved',
    'scheduled',
    'publishing',
    'published',
    'paused',
    'paused_credits',
    'failed',
    'rejected',
    'cancelled',
    'missed',
    'admin_test'
  ));
