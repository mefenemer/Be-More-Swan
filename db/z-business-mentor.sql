-- db/z-business-mentor.sql — the Business Mentor (role_key `business_mentor`), Phase 1a.
-- Plan: docs/business-mentor-plan.md (§2 decisions, §3.13 proposals, §8.2 success measures).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-business-mentor                              (staging)
--   npm run db:migrate:apply -- --only z-business-mentor --url-var DATABASE_URL_PROD  (prod)
--
-- Four things:
--   1. mentor_proposals — every suggestion the Mentor shows, and what the user did with it. Feeds the
--      3-a-week cap, "dismiss with a reason", the Dismissed list and Admin ▸ Mentor activity.
--   2. The catalogue row, inserted HIDDEN (is_active=false, coming_soon=false): nobody sees it until an
--      admin changes its status on Admin ▸ Assistants (admin-assistants.ts, the only status writer).
--      ON CONFLICT DO NOTHING: once the row exists, every field is the admin's.
--   3. Its model: Opus 5.5, thinking Low (owner decision §2.4). A row here, not a code default, so
--      every other role's chat keeps its own default. ON CONFLICT DO NOTHING: the admin's later
--      choice on Admin ▸ Assistants ▸ Model & rules wins.
--   4. The `business_mentor` feature flag, OFF and whitelisting nobody. Rollout (§8.5): add test
--      workspace ids to allowed_workspace_ids, then enable for everyone.

BEGIN;

CREATE TABLE IF NOT EXISTS mentor_proposals (
  id                   serial PRIMARY KEY,
  organisation_id      integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- The workspace's Mentor that made it.
  ai_assistant_id      integer REFERENCES ai_assistants(id) ON DELETE SET NULL,
  -- The assistant it would change (NULL for Business Information, support, strategy).
  target_assistant_id  integer REFERENCES ai_assistants(id) ON DELETE SET NULL,
  -- What kind of change: e.g. 'business_info_gap', 'assistant_settings', 'goal', 'schedule',
  -- 'setup_field', 'support_request'. Free text so a new card needs no migration.
  kind                 text NOT NULL,
  title                text NOT NULL,
  -- The "Why?" line: [{ "text": "...", "href": "/..." }]. A proposal with none is never shown (§3.13).
  evidence             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The card itself, as drawn, so it can be shown again in the Inbox or the Dismissed list.
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'shown',
  dismiss_reason       text,
  snoozed_until        timestamptz,
  shown_at             timestamptz NOT NULL DEFAULT now(),
  decided_at           timestamptz,
  decided_by           integer REFERENCES users(id) ON DELETE SET NULL,
  chat_session_id      integer,
  chat_message_id      integer,
  CONSTRAINT mentor_proposals_status_check
    CHECK (status IN ('shown', 'accepted', 'dismissed', 'failed', 'expired')),
  CONSTRAINT mentor_proposals_dismiss_reason_check
    CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('not_relevant', 'already_done', 'disagree', 'not_now'))
);

-- The weekly cap and the activity screen read by workspace and week.
CREATE INDEX IF NOT EXISTS mentor_proposals_org_shown_idx ON mentor_proposals (organisation_id, shown_at DESC);
-- "Don't suggest that again": dismissed proposals by kind.
CREATE INDEX IF NOT EXISTS mentor_proposals_org_kind_status_idx ON mentor_proposals (organisation_id, kind, status);

INSERT INTO master_assistants
    (role_key, name, description, category, icon_key, icon_color, tagline, key_features, integrations, works_with, coming_soon, is_active)
VALUES (
    'business_mentor',
    'Business Mentor',
    'Your guide to Be More Swan and a business coach who knows your workspace. It reads your business details and how your assistants are doing, points out what to fix first, and suggests changes you approve with one click. Included on every plan, and it never takes one of your assistant slots.',
    'Operations',
    'chart',
    'pink',
    'A coach that knows your business — and your team.',
    '["Knows Your Workspace","Suggests, You Approve","Help With Be More Swan"]'::jsonb,
    '[]'::jsonb,
    '["standalone"]'::jsonb,
    false,
    false
)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO assistant_model_settings (role_key, model, thinking)
VALUES ('business_mentor', 'claude-opus-5-5', 'low')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO feature_flags (key, enabled, rollout_percentage, allowed_workspace_ids, description)
VALUES ('business_mentor', false, 0, '{}',
        'Business Mentor: provision and show the Mentor. Whitelist test workspaces first, then enable. docs/business-mentor-plan.md §8.5')
ON CONFLICT (key) DO NOTHING;

COMMIT;
