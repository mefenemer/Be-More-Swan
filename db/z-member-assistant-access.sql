-- db/z-member-assistant-access.sql — a teammate can be given some assistants, not all of them.
-- src/utils/assistant-access.ts (the rule), src/utils/tenant.ts (enforces it on every request
-- that names an assistant), netlify/functions/invite-member.ts + manage-members.ts (set it).
-- Drizzle mirror: db/schema.ts (userOrganisations.assistantIds).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys (tenant.ts selects
-- the column on every request). Idempotent.
--   npm run db:migrate:apply -- --only z-member-assistant-access.sql                              (staging)
--   npm run db:migrate:apply -- --only z-member-assistant-access.sql --url-var DATABASE_URL_PROD  (prod)
--
-- assistant_ids  NULL = every assistant in the workspace (every existing row, and always for owners
--                and admins). A list = only those ai_assistants ids. Ids of assistants since
--                deleted are ignored, not cleaned up.

BEGIN;

ALTER TABLE user_organisations ADD COLUMN IF NOT EXISTS assistant_ids INTEGER[];

COMMIT;
