-- db/assistant-records-lead-idea.sql
-- Widen the assistant_records CHECK constraints so the Lead Generator's proactive tools
-- (netlify/functions/lead-generation.ts) can actually persist what they produce.
-- APPLY MANUALLY (project convention — new db/*.sql are not pushed by drizzle-kit).
--
-- Why: lead-generation.ts writes two values the original constraints never allowed —
--   * score_lead    → source 'manual'    (the Data Hub "Add Lead" button)
--   * generate_ideas→ recordType 'lead_idea', source 'agent'  ("Review Lead Ideas")
-- Both inserts raised a check violation, which the function's catch-all masked as a
-- generic 502 ("The Lead Generation Assistant is having trouble right now"). Discovery-
-- found leads were unaffected because process-discovery-jobs.ts writes source
-- 'integration', which was already legal — hence "discovery works, manual add doesn't".
--
-- 'lead_idea' is additive: every Data Hub / Review Queue query filters on an explicit
-- record_type, so existing reads are untouched by the new type.

BEGIN;

ALTER TABLE assistant_records
  DROP CONSTRAINT IF EXISTS assistant_records_source_check;
ALTER TABLE assistant_records
  ADD CONSTRAINT assistant_records_source_check
  CHECK (source IN ('chat', 'csv_import', 'integration', 'manual', 'agent'));

ALTER TABLE assistant_records
  DROP CONSTRAINT IF EXISTS assistant_records_type_check;
ALTER TABLE assistant_records
  ADD CONSTRAINT assistant_records_type_check
  CHECK (record_type IN ('lead', 'enrichment', 'meeting', 'invoice', 'ticket', 'lead_idea'));

COMMIT;
