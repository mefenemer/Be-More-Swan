-- db/z-social-messages.sql — Facebook Page + Instagram messages (docs/meta-messages-plan.md, Phase 1).
-- netlify/functions/meta-webhook.ts stores every message Meta sends us here; the Messages tab
-- (Phase 2) reads it. One conversation per (connection, person). A reply goes out only from a
-- person's click and only while window_closes_at (the person's last message + 24h) is in the future.
-- Drizzle mirror: db/schema.ts (socialConversations, socialMessages).
--
-- APPLY MANUALLY, staging and prod separately, BEFORE the code deploys — until it runs the webhook
-- answers 200 and drops what it can't store (Meta retries a 500, so a missing table must not 500).
-- Idempotent. No change to existing tables.
--
-- participant_id is the page-scoped / Instagram-scoped id of the person, never a Facebook user id.
-- body is null for an attachment-only message and after the 90-day text purge (owner decision D6).
-- Meta's attachment URLs are not stored. mid = Meta's message id, unique: retries and the echo of our
-- own send dedupe on it.

BEGIN;

CREATE TABLE IF NOT EXISTS social_conversations (
    id                   SERIAL PRIMARY KEY,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id      INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,
    connection_id        INTEGER NOT NULL REFERENCES system_connections(id) ON DELETE CASCADE,
    platform             TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),
    account_external_id  TEXT NOT NULL,
    participant_id       TEXT NOT NULL,
    participant_name     TEXT,
    last_inbound_at      TIMESTAMP,
    last_outbound_at     TIMESTAMP,
    window_closes_at     TIMESTAMP,
    status               TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'dismissed')),
    draft_reply          TEXT,
    created_at           TIMESTAMP NOT NULL DEFAULT now(),
    updated_at           TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_conversations_connection_participant_uq ON social_conversations (connection_id, participant_id);
CREATE INDEX IF NOT EXISTS social_conversations_assistant_status_idx ON social_conversations (ai_assistant_id, status, last_inbound_at DESC);
CREATE INDEX IF NOT EXISTS social_conversations_org_idx ON social_conversations (organisation_id);

CREATE TABLE IF NOT EXISTS social_messages (
    id                SERIAL PRIMARY KEY,
    organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    conversation_id   INTEGER NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
    direction         TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    mid               TEXT NOT NULL,
    body              TEXT,
    attachment_type   TEXT,
    sent_at           TIMESTAMP NOT NULL,
    sent_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_messages_mid_uq ON social_messages (mid);
CREATE INDEX IF NOT EXISTS social_messages_conversation_idx ON social_messages (conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS social_messages_org_idx ON social_messages (organisation_id);

COMMIT;

-- Check: expect 2 rows.
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('social_conversations', 'social_messages');
