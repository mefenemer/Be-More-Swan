-- Chat Persistence (Digital Assistant Orchestrator) — chat_sessions + chat_messages.
--
-- One chat_sessions row per conversation thread between a user and a per-org assistant
-- instance (ai_assistants, NOT master_assistants). Every turn — user, assistant, or
-- injected system message — is one chat_messages row. ui_element_json stores the
-- serialised state of "Disruptive UI" blocks (Lead Scoring Card, Action Item table, …)
-- returned alongside an assistant reply, so a transcript re-hydrates exactly as first
-- rendered. Written/read by netlify/functions/chat-orchestrator.ts.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see
-- the no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS chat_sessions (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_assistant_id  INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'active',      -- 'active' | 'archived'
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id               SERIAL PRIMARY KEY,
  chat_session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,                       -- 'user' | 'assistant' | 'system'
  content          TEXT NOT NULL,
  ui_element_json  JSONB,                               -- Disruptive UI block state (nullable)
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);

-- Hot path: "my open conversations in this workspace" (tenant-scoped list).
CREATE INDEX IF NOT EXISTS chat_sessions_org_user_status_idx
  ON chat_sessions (organisation_id, user_id, status);

CREATE INDEX IF NOT EXISTS chat_sessions_assistant_idx
  ON chat_sessions (ai_assistant_id);

-- Hot path: replaying a session's transcript in order.
CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
  ON chat_messages (chat_session_id, created_at);

-- Constrain status/role to the known sets (idempotent adds).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_sessions_status_check'
  ) THEN
    ALTER TABLE chat_sessions
      ADD CONSTRAINT chat_sessions_status_check
      CHECK (status IN ('active', 'archived'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_role_check'
  ) THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_role_check
      CHECK (role IN ('user', 'assistant', 'system'));
  END IF;
END $$;
