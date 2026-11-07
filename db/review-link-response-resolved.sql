-- db/review-link-response-resolved.sql: the subscriber can mark a guest's comment as done or ignore it
-- (2026-11-07). Using a comment to redraft no longer makes it vanish; it stays until they choose.
--
-- Apply on staging, then prod, BEFORE the code (listReviewLinks selects these columns). Safe to re-run.
-- Needs db/review-links.sql first.

BEGIN;

ALTER TABLE review_link_responses ADD COLUMN IF NOT EXISTS resolution  TEXT;
ALTER TABLE review_link_responses ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
ALTER TABLE review_link_responses ADD COLUMN IF NOT EXISTS resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE review_link_responses DROP CONSTRAINT IF EXISTS review_link_responses_resolution_check;
ALTER TABLE review_link_responses ADD CONSTRAINT review_link_responses_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('done','ignored'));

COMMIT;

SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'review_link_responses' AND column_name IN ('resolution','resolved_at','resolved_by');
