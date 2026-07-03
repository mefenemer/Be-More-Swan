-- Migration: security_audits — moderation hard-block log (US2 AC2.3).
-- Applied manually (like db/gamification.sql) rather than via `drizzle-kit push`,
-- which would also try to DISABLE RLS on ai_assistants (RLS lives in db/rls/).
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS security_audits (
  id serial PRIMARY KEY,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  organisation_id integer REFERENCES organisations(id) ON DELETE SET NULL,
  source text NOT NULL,                       -- entry point, e.g. 'quality-review' | 'generate-post'
  flagged_categories jsonb NOT NULL,          -- string[] of OpenAI moderation categories
  prompt_excerpt text,                        -- first ~200 chars for review context
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_audits_user_idx ON security_audits(user_id);
CREATE INDEX IF NOT EXISTS security_audits_created_idx ON security_audits(created_at);
