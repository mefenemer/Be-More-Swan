-- db/z-chat-task-tally.sql — counts delivered chat replies per month, for 1 task per 10 messages (owner, 2026-11-06).
-- Code: src/utils/basic-work.ts. Drizzle mirror: db/schema.ts (chatTaskTally). Plan: docs/basic-work-charging.md.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, before BASIC_WORK_CHARGED_FROM takes effect. Idempotent.
--   npm run db:migrate:apply -- --only z-chat-task-tally                              (staging)
--   npm run db:migrate:apply -- --only z-chat-task-tally --url-var DATABASE_URL_PROD  (prod)
--
-- Nothing reads this table until the switch is on, so it can land in any order.

CREATE TABLE IF NOT EXISTS chat_task_tally (
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    period_start     TIMESTAMP NOT NULL,
    messages         INTEGER NOT NULL DEFAULT 0,
    updated_at       TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, period_start)
);
