-- db/z-meeting-bots.sql — the Note Taker joins a call itself (docs/note-taker-bot-plan.md §4, step 2).
-- A bot from Recall.ai is sent into a Google Meet, Teams or Zoom call; when the call ends its transcript goes
-- through the meeting pick-up engine (meeting_imports, db/z-meeting-imports.sql — apply that FIRST) into the
-- Inbox, waiting for approval. Code: src/utils/meeting-bot.ts (rules), meeting-bot-recall.ts (Recall),
-- meeting-bot-db.ts (store + state), netlify/functions/meeting-bots.ts (send/list/remove),
-- recall-webhook.ts (Recall's events). Drizzle mirror: db/schema.ts (meetingBots, meetingImports.via).
--
-- APPLY MANUALLY, staging and prod separately, BEFORE the code deploys (meeting_imports reads select `via`).
-- Additive and idempotent. The flag stays OFF: nothing can send a bot until it is switched on for a workspace.
--
-- meeting_bots: one row per bot sent.
--   status: scheduled | joining | waiting_room | in_call | ended | done | not_admitted | removed | cancelled | failed
--   ('ended' = left the call, transcript not final yet; 'done' = Recall finished, transcript ready).
--   recall_region: 'eu' | 'us' — which Recall account (each region is its own account and key). Fixed per bot.
--   minutes_in_call: what the charge is worked out from (1 task per started 5 minutes, after the minutes are filed).
--   media_deleted_at: Recall's copy of the recording is deleted once the minutes are filed (or the write-up gave up).
--   status_reason never holds meeting text: a Recall sub-code or our own short reason.
-- meeting_imports.via: 'transcript' (the platform's own transcript, picked up) | 'bot' (our bot's transcript).

BEGIN;

CREATE TABLE IF NOT EXISTS meeting_bots (
    id                    SERIAL PRIMARY KEY,
    organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id       INTEGER REFERENCES ai_assistants(id) ON DELETE CASCADE,
    requested_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source                TEXT NOT NULL DEFAULT 'link' CHECK (source IN ('link', 'chat', 'calendar')),
    platform              TEXT NOT NULL CHECK (platform IN ('google_meet', 'teams', 'zoom')),
    meeting_url           TEXT NOT NULL,
    title                 TEXT,
    join_at               TIMESTAMP NOT NULL,
    length_limit_minutes  INTEGER NOT NULL DEFAULT 120,
    recall_region         TEXT NOT NULL CHECK (recall_region IN ('eu', 'us')),
    recall_bot_id         TEXT,
    status                TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'joining', 'waiting_room', 'in_call', 'ended', 'done', 'not_admitted', 'removed', 'cancelled', 'failed')),
    status_reason         TEXT,
    joined_at             TIMESTAMP,
    left_at               TIMESTAMP,
    minutes_in_call       INTEGER,
    import_id             INTEGER REFERENCES meeting_imports(id) ON DELETE SET NULL,
    media_deleted_at      TIMESTAMP,
    created_at            TIMESTAMP NOT NULL DEFAULT now(),
    updated_at            TIMESTAMP NOT NULL DEFAULT now()
);
-- Pressing Send twice sends one bot. OPEN bots only: a cancelled, refused or finished bot must not block booking the same
-- meeting again for the same time (review of #769). meeting-bot-db.ts uses the same condition as its conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_bots_org_url_join_open_uq ON meeting_bots (organisation_id, meeting_url, join_at)
    WHERE status IN ('scheduled', 'joining', 'waiting_room', 'in_call', 'ended');
CREATE UNIQUE INDEX IF NOT EXISTS meeting_bots_recall_uq ON meeting_bots (recall_region, recall_bot_id) WHERE recall_bot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_bots_open_idx ON meeting_bots (status, updated_at) WHERE status IN ('scheduled', 'joining', 'waiting_room', 'in_call', 'ended');
CREATE INDEX IF NOT EXISTS meeting_bots_org_idx ON meeting_bots (organisation_id, join_at DESC);

ALTER TABLE meeting_imports ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'transcript';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'meeting_imports'::regclass AND conname = 'meeting_imports_via_check') THEN
        ALTER TABLE meeting_imports ADD CONSTRAINT meeting_imports_via_check CHECK (via IN ('transcript', 'bot'));
    END IF;
END $$;

-- The charge (also in db/z-task-costs.sql's baseline, the usual place): 1 task per started 5 minutes in a call, set in
-- Admin → Money → Task costs. Nobody is charged before launch: the meeting_bot flag below stays off until the 30-day
-- Terms notice has run (docs/note-taker-bot-legal.md §1).
INSERT INTO task_cost_change_items (change_id, cost_key, new_units)
VALUES (1, 'meeting_bot_call', 1)
ON CONFLICT (change_id, cost_key) DO NOTHING;

-- OFF for everyone. Turn on per workspace (allowed_workspace_ids) for testing; for everyone only on launch day, once
-- DPA 1.2, Terms 2.5 and the notices are out (docs/note-taker-bot-legal.md §1). Gates every way to send a bot
-- (meeting-bots.ts) and what the chat can offer.
INSERT INTO feature_flags (key, enabled, rollout_percentage, allowed_workspace_ids, description)
VALUES ('meeting_bot', FALSE, 0, NULL,
        'Note Taker joins Google Meet, Teams and Zoom calls itself (Recall.ai bot), 1 task per started 5 minutes. Customers only on launch day (DPA 1.2, Terms 2.5, notices).')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Check: expect 1, 1, 1, 1.
-- SELECT count(*) FROM information_schema.tables WHERE table_name = 'meeting_bots';
-- SELECT count(*) FROM information_schema.columns WHERE table_name = 'meeting_imports' AND column_name = 'via';
-- SELECT count(*) FROM task_cost_change_items WHERE cost_key = 'meeting_bot_call';
-- SELECT count(*) FROM feature_flags WHERE key = 'meeting_bot';
