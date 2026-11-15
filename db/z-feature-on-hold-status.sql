-- db/z-feature-on-hold-status.sql — Feature requests gain an "On Hold" status (owner, 2026-11-15).
-- For a request the owner is undecided about: nothing is built until it is reopened. Shown in Backlog
-- with a "⏸️ On hold" pill; still on the public board, not on the roadmap.
-- Re-runnable: drops and recreates the status CHECK with the full list (same as db/feature-requests.sql).
-- Run on staging and production BEFORE the code that offers the status is live, or choosing it fails.

ALTER TABLE feature_requests DROP CONSTRAINT IF EXISTS feature_requests_status_check;
ALTER TABLE feature_requests
  ADD CONSTRAINT feature_requests_status_check
  CHECK (status IN ('pending_review', 'under_review', 'open', 'planned', 'brief_ready',
                    'in_progress', 'on_hold', 'released', 'declined', 'duplicate'));
