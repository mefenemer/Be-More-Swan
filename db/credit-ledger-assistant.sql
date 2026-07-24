-- Group C / Request 0.2: per-assistant credit attribution on the Billing "Usage & Credits" panel.
--
-- Media debits already carry an assistant via ai_credit_ledger.job_id → media_generation_jobs.assistant_id
-- (set for every assistant-driven generation), so they need no new column and are attributed with a
-- read-time join. X-post debits have no job row, so they need the assistant stamped directly on the
-- ledger. Nullable + ON DELETE SET NULL: manual/user spend legitimately has no assistant, and an
-- assistant being removed must never orphan the historical ledger.
ALTER TABLE ai_credit_ledger
  ADD COLUMN IF NOT EXISTS assistant_id integer REFERENCES ai_assistants(id) ON DELETE SET NULL;

-- Current-month per-assistant rollups scan the org's recent debits; this keeps that cheap.
CREATE INDEX IF NOT EXISTS ai_credit_ledger_assistant_idx
  ON ai_credit_ledger (organisation_id, assistant_id, created_at);
