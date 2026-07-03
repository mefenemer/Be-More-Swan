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
    'failed',
    'rejected',
    'cancelled',
    'missed',
    'admin_test'
  ));
