-- db/z-team-feed.sql
-- The Team feed (docs/campaign-orchestrator-flow.md §4) and a campaign's effect on usual posting.
-- Owner, 2026-10-14: assistants and the user tell each other things and ask questions in one feed,
-- in the side menu; and a campaign can make the usual Autopilot posting give way while it runs.
--
-- ⚠️ APPLY TO BOTH ENVS BEFORE THE CODE DEPLOYS. `campaigns` is read with bare db.select()
-- (campaigns.ts requireCampaign), which names every column in the drizzle mirror — the code before
-- this file breaks the whole Campaigns tab (schema-column-breaks-reads-until-applied).
-- Idempotent: safe to run twice.

-- What the workspace's USUAL posting does while this campaign is live, per kind of work:
--   make_way — Autopilot only fills days the campaign is not using (the default)
--   pause    — no usual posts at all until the campaign ends, is paused or stops
--   normal   — carries on as if there were no campaign
-- Read only while the campaign is active/throttled, so usual posting restarts by itself.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS usual_posting jsonb NOT NULL
    DEFAULT '{"social":"make_way","blog":"make_way"}'::jsonb;

-- One message in the Team feed. Every assistant-written message is generated from a state change
-- that actually happened (never by a model); a user's message is theirs, word for word.
CREATE TABLE IF NOT EXISTS team_messages (
    id                 serial PRIMARY KEY,
    organisation_id    integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    campaign_id        integer REFERENCES campaigns(id) ON DELETE CASCADE,
    campaign_order_id  integer REFERENCES campaign_orders(id) ON DELETE SET NULL,
    from_assistant_id  integer REFERENCES ai_assistants(id) ON DELETE CASCADE,
    from_user_id       integer REFERENCES users(id) ON DELETE SET NULL,
    to_assistant_id    integer REFERENCES ai_assistants(id) ON DELETE CASCADE,
    -- Addressed to the person (counts as unread for them); assistant-to-assistant traffic is not.
    to_user            boolean NOT NULL DEFAULT false,
    kind               text NOT NULL,
    body               text NOT NULL,
    -- Where to act on it: { assistantId, tab, label } or { assistantId, chat: true, label }.
    link               jsonb,
    -- A question with answer buttons: { key, ref, choices: [{ value, label }] }.
    question           jsonb,
    answer             text,
    answered_at        timestamp,
    answered_by        integer REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_messages_kind_check') THEN
        ALTER TABLE team_messages ADD CONSTRAINT team_messages_kind_check
            CHECK (kind IN ('brief', 'started', 'waiting', 'ready', 'done', 'cancelled', 'question', 'message', 'reply'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS team_messages_org_idx       ON team_messages (organisation_id, id DESC);
CREATE INDEX IF NOT EXISTS team_messages_campaign_idx  ON team_messages (campaign_id, id DESC);
CREATE INDEX IF NOT EXISTS team_messages_order_idx     ON team_messages (campaign_order_id, kind);
CREATE INDEX IF NOT EXISTS team_messages_from_asst_idx ON team_messages (from_assistant_id, id DESC);
CREATE INDEX IF NOT EXISTS team_messages_to_asst_idx   ON team_messages (to_assistant_id, id DESC);

-- How far each person has read. One high-water mark per person per workspace: opening Team reads it.
CREATE TABLE IF NOT EXISTS team_reads (
    organisation_id  integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id          integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id     integer NOT NULL DEFAULT 0,
    updated_at       timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, user_id)
);

-- RLS: deliberately OFF, as for the campaign tables (db/campaigns.sql): the app connects as table
-- owner, so a policy would read as protection while never evaluating. Isolation is requireTenant()
-- + organisation_id scoping in netlify/functions/team.ts.
