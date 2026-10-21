-- db/z-mystery-shopper-rejected-ideas.sql
-- The Mystery Shopper's "Ideas for your other assistants" can be REJECTED (owner, 2026-10-21): the idea
-- leaves To review for Archived, and later checks are told not to suggest it again
-- (src/utils/site-audit-covered.ts). A rejection is recorded in site_audit_briefs with
-- source = 'rejected_idea' — the same row an idea's "Brief <name>" writes, so an idea is either
-- briefed or rejected, never both, and "Bring back" deletes the row (site-audits.ts unbrief).
--
-- Additive and re-runnable. Apply to BOTH databases BEFORE the code that sends 'rejected_idea'
-- deploys; until then the Reject button says it needs a database update (site-audits.ts, 23514).

BEGIN;

ALTER TABLE site_audit_briefs DROP CONSTRAINT IF EXISTS site_audit_briefs_source_check;
ALTER TABLE site_audit_briefs ADD CONSTRAINT site_audit_briefs_source_check
    CHECK (source IN ('idea', 'stalled_fix', 'chat', 'rejected_idea'));

ALTER TABLE site_audit_briefs DROP CONSTRAINT IF EXISTS site_audit_briefs_shape_check;
ALTER TABLE site_audit_briefs ADD CONSTRAINT site_audit_briefs_shape_check CHECK (
    (source IN ('idea', 'rejected_idea') AND run_id IS NOT NULL AND handoff_index IS NOT NULL)
    OR (source = 'stalled_fix' AND fix_id IS NOT NULL)
    OR source = 'chat'
);

-- One decision per idea: briefed OR rejected, once.
CREATE UNIQUE INDEX IF NOT EXISTS site_audit_briefs_rejected_idea_uq
    ON site_audit_briefs (run_id, handoff_index) WHERE source = 'rejected_idea';

COMMIT;
