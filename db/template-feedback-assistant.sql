-- db/template-feedback-assistant.sql
-- Phase 5a slice 2 — give `template_feedback` a direct link to the assistant whose playbook the
-- edit is about. Design: docs/strategy-agent-plan.md §4.1.
--
-- ── The gap this closes ─────────────────────────────────────────────────────
-- The edit-pattern proposer groups edits by (org, ASSISTANT, edit_reason), because what it produces
-- is a rewrite of one assistant's outreach playbook. The plan assumed the assistant was reachable by
-- joining template_feedback → lead_messages → lead_threads.
--
-- It is not. The ⭐ review-time path (`record_edit_feedback` in lead-generation.ts) writes
-- `lead_message_id = NULL` **by design and correctly**: the edit happens at the review gate, BEFORE
-- the message is sent, so no lead_messages row exists yet. That is the primary — currently the only
-- — source of this evidence. An inner join through lead_messages therefore matches nothing, and
-- would have made the proposer a function that runs weekly and permanently finds no clusters.
--
-- Nullable, not NOT NULL: a future send-time edit path legitimately has a lead_message_id and may
-- leave this unset, and the proposer coalesces the two. Making it required would force that path to
-- duplicate a value it can already derive.
--
-- ── Deploy ordering: APPLY BEFORE DEPLOYING ─────────────────────────────────
-- src/utils/template-feedback.ts writes this column. A code-first deploy makes every edit-feedback
-- write fail — and that writer swallows its errors by contract, so the failure is SILENT: the strip
-- would report success and bank nothing.
--
-- Idempotent: guarded throughout, safe to run repeatedly.
--
--   npm run db:migrate:apply -- --only template-feedback-assistant --yes
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only template-feedback-assistant --url-var PROD_DATABASE_URL --yes

BEGIN;

ALTER TABLE template_feedback
  ADD COLUMN IF NOT EXISTS ai_assistant_id integer REFERENCES ai_assistants(id) ON DELETE CASCADE;

-- Backfill whatever IS reachable through the message → thread path. Expected to touch zero rows
-- today (every existing row came from the review-time path and has a NULL lead_message_id), but it
-- is what makes the column correct rather than merely present, and it must run before any reader
-- treats a NULL as "no assistant" instead of "not yet resolved".
UPDATE template_feedback tf
   SET ai_assistant_id = lt.ai_assistant_id
  FROM lead_messages lm
  JOIN lead_threads lt ON lt.id = lm.lead_thread_id
 WHERE tf.lead_message_id = lm.id
   AND tf.ai_assistant_id IS NULL;

-- The proposer's grouping key. Partial: rows with no assistant are unusable to it, and there is no
-- point indexing them.
CREATE INDEX IF NOT EXISTS template_feedback_assistant_reason_idx
  ON template_feedback (ai_assistant_id, edit_reason, created_at)
  WHERE ai_assistant_id IS NOT NULL;

COMMIT;
