-- db/assistant-model-settings.sql
-- The Claude model (and thinking level) an admin has chosen for an assistant ROLE, on Admin ▸
-- Assistants ▸ Model & rules (src/utils/assistant-model.ts, src/config/model-options.ts).
--
-- One row per role_key (masterAssistants.roleKey). NO row = the role runs on the models written in
-- the code, exactly as before — so an empty table changes nothing, and so does a missing one:
-- loadRoleModel() treats "relation does not exist" as "no choice made". The code can therefore ship
-- before this file is applied; the admin page just refuses to save until it is. Staging first:
--   npm run db:migrate:apply -- --only assistant-model-settings.sql
--   npm run db:migrate:apply -- --only assistant-model-settings.sql --url-var DATABASE_URL_PROD
--
-- A separate table rather than a column on master_assistants on purpose: a new column there breaks
-- every whole-row select of that table until the SQL is applied (memory: schema column breaks reads).
-- Idempotent.

CREATE TABLE IF NOT EXISTS assistant_model_settings (
  role_key    text PRIMARY KEY,
  model       text NOT NULL,
  thinking    text NOT NULL DEFAULT 'low',
  updated_by  integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_model_settings_thinking_check CHECK (thinking IN ('off','low','medium','high'))
);

-- Verify (expect the table, empty):
--   SELECT * FROM assistant_model_settings;
