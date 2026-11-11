-- db/z-task-costs.sql — what each piece of work costs in tasks, set by a super admin, not in code.
-- Code: src/utils/task-costs.ts (read), netlify/functions/admin-task-costs.ts (Admin → Revenue → Task costs),
-- netlify/functions/task-cost-review.ts (the owner's review and accept), netlify/functions/task-costs.ts (public figures).
-- Drizzle mirror: db/schema.ts (taskCostChanges, taskCostChangeItems, taskCostAcceptances).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-task-costs                              (staging)
--   npm run db:migrate:apply -- --only z-task-costs --url-var DATABASE_URL_PROD  (prod)
--
-- ORDER: any order. Until this exists metering keeps today's costs (DEFAULT_TASK_COSTS) and the admin
-- screen says the table is missing. The starting costs below MUST equal DEFAULT_TASK_COSTS
-- (tests/task-costs.test.ts holds them together), so applying this changes nobody's charges.
--
-- A cost is never overwritten. Each change is a row with the date it takes effect and its items, and
-- the cost on any day is the newest item in force. So a change announced for next month is already in
-- the table, and starts by itself on its date. status:
--   baseline  → in force from its date, no notice (the starting costs, and costs nobody is charged yet)
--   draft     → an admin's work in progress; affects nothing
--   announced → the notice has gone out; in force from effective_from; asks for acceptance
--   cancelled → withdrawn before its date; affects nothing

BEGIN;

CREATE TABLE IF NOT EXISTS task_cost_changes (
    id              SERIAL PRIMARY KEY,
    status          TEXT NOT NULL CHECK (status IN ('baseline', 'draft', 'announced', 'cancelled')),
    effective_from  TIMESTAMP NOT NULL,                 -- 00:00 UTC on the day it starts
    reason          TEXT NOT NULL DEFAULT '',           -- shown to customers in the notice
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP NOT NULL DEFAULT now(),
    announced_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    announced_at    TIMESTAMP,
    cancelled_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at    TIMESTAMP
);

-- One draft at a time. An announced change still to start also blocks a new draft (admin-task-costs.ts):
-- a second would quote "from" figures the first is about to replace.
CREATE UNIQUE INDEX IF NOT EXISTS task_cost_changes_one_draft ON task_cost_changes ((status)) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS task_cost_change_items (
    change_id   INTEGER NOT NULL REFERENCES task_cost_changes(id) ON DELETE CASCADE,
    cost_key    TEXT NOT NULL,
    old_units   INTEGER,                                 -- NULL on the starting costs
    new_units   INTEGER NOT NULL CHECK (new_units >= 0),
    PRIMARY KEY (change_id, cost_key)
);

-- The workspace owner's acceptance, once per workspace per change (owner decision 2026-11-06).
CREATE TABLE IF NOT EXISTS task_cost_acceptances (
    change_id        INTEGER NOT NULL REFERENCES task_cost_changes(id) ON DELETE CASCADE,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    accepted_at      TIMESTAMP NOT NULL DEFAULT now(),
    ip_address       TEXT,                               -- truncated (src/utils/ip-pseudonymise.ts)
    user_agent       TEXT,
    PRIMARY KEY (change_id, organisation_id)
);
CREATE INDEX IF NOT EXISTS task_cost_acceptances_org_idx ON task_cost_acceptances (organisation_id);

-- The starting costs: what src/config/task-weights.ts charged until this table took over.
INSERT INTO task_cost_changes (id, status, effective_from, reason)
VALUES (1, 'baseline', '2026-10-17 00:00:00', 'Starting costs (the single task allowance, 17 October 2026).')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('task_cost_changes', 'id'), GREATEST((SELECT MAX(id) FROM task_cost_changes), 1));

INSERT INTO task_cost_change_items (change_id, cost_key, new_units) VALUES
    (1, 'social_post', 1),
    (1, 'blog_article', 1),
    (1, 'lead_search', 1),
    (1, 'email_issue', 1),
    (1, 'email_campaign', 1),
    (1, 'outreach_email', 1),
    (1, 'site_audit', 1),
    (1, 'site_draft', 1),
    (1, 'site_words', 1),
    (1, 'ai_image', 1),
    (1, 'ai_video', 20),
    (1, 'ai_music', 20),
    (1, 'ai_music_shared', 12),
    (1, 'ai_voiceover', 1),
    (1, 'x_link_post', 10),
    (1, 'mentor_research', 1),
    (1, 'mentor_strategy', 1),
    (1, 'mentor_review', 1),
    (1, 'flyer_words', 1),
    (1, 'background_removal', 1),
    (1, 'footage_review', 2),
    (1, 'chat_messages', 1),
    (1, 'editing_helper', 1),
    (1, 'design_round', 1),
    (1, 'finished_design', 1),
    (1, 'ai_video_per_second', 4),
    (1, 'chat_messages_per_task', 10)
ON CONFLICT (change_id, cost_key) DO NOTHING;

COMMIT;
