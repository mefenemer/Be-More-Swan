-- db/z-business-mentor-phase-2.sql — the Business Mentor, Phase 2: idea check and strategy documents.
-- Plan: docs/business-mentor-plan.md §4 (§4.4 storage, §4.5 research).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and
-- prod separately). Idempotent: safe to re-run. The code tolerates both tables being missing: the Plan
-- tab says "not ready yet", saving refuses with 503, and drafting prompts simply carry no strategy.
--
-- Two tables:
--   1. strategy_documents — the idea check (interview answers, Lean Canvas, riskiest assumptions), the
--      business plan and the marketing plan. Versioned: at most ONE draft per kind (the working copy)
--      and ONE approved; approving a draft supersedes the approved version, which is kept.
--      Approved documents reach every drafting prompt through src/utils/business-knowledge.ts.
--   2. mentor_jobs — the Mentor's background work: research with sources (§4.5) and drafting a
--      strategy document. Both run in mentor-job-background.ts (a grounded search takes ~2 minutes;
--      a chat turn is cut at 26 s) and each spends 1 task when it delivers (owner decision §2.1).

BEGIN;

CREATE TABLE IF NOT EXISTS strategy_documents (
  id               serial PRIMARY KEY,
  organisation_id  integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  -- 1, 2, 3… per organisation and kind. A new draft takes the next number.
  version          integer NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  -- { "sections": { "<key>": "<text>" }, "assumptions": [{ "assumption": "...", "test": "..." }] }
  -- Section keys per kind: src/utils/strategy-documents.ts STRATEGY_KINDS.
  body             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by       integer REFERENCES users(id) ON DELETE SET NULL,
  approved_by      integer REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_documents_kind_check CHECK (kind IN ('idea_check', 'business_plan', 'marketing_plan')),
  CONSTRAINT strategy_documents_status_check CHECK (status IN ('draft', 'approved', 'superseded')),
  CONSTRAINT strategy_documents_version_key UNIQUE (organisation_id, kind, version)
);

-- One working draft and one approved version per kind, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS strategy_documents_one_draft_idx
  ON strategy_documents (organisation_id, kind) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS strategy_documents_one_approved_idx
  ON strategy_documents (organisation_id, kind) WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS mentor_jobs (
  id               serial PRIMARY KEY,
  organisation_id  integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id  integer REFERENCES ai_assistants(id) ON DELETE SET NULL,
  user_id          integer REFERENCES users(id) ON DELETE SET NULL,
  -- 'research' | 'strategy_draft'
  kind             text NOT NULL,
  status           text NOT NULL DEFAULT 'queued',
  -- research: { "question": "..." }   strategy_draft: { "kind": "business_plan" }
  input            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- research: { "answer": "...", "sources": [{ "url", "title" }], "searchCount": n }
  -- strategy_draft: { "sections": {...}, "assumptions": [...] }
  result           jsonb,
  error            text,
  -- Where the answer is posted when it is ready (the Mentor's chat with this user), if it was asked there.
  chat_session_id  integer REFERENCES chat_sessions(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  CONSTRAINT mentor_jobs_kind_check CHECK (kind IN ('research', 'strategy_draft')),
  CONSTRAINT mentor_jobs_status_check CHECK (status IN ('queued', 'running', 'done', 'failed'))
);

-- The Research list and "is one already running?" read by workspace, newest first.
CREATE INDEX IF NOT EXISTS mentor_jobs_org_created_idx ON mentor_jobs (organisation_id, kind, created_at DESC);

COMMIT;

-- Check it landed (both should return a row):
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('strategy_documents', 'mentor_jobs');
