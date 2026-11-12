-- db/z-mailboxes.sql — the Email Assistant's mailboxes (docs/email-assistant-plan.md §3.3, Phase 1).
-- Code: src/utils/mailboxes.ts (tokens, delete on disconnect), src/utils/mail-reader/ (reading),
-- netlify/functions/mailbox-oauth.ts (connect), netlify/functions/mailboxes.ts (the Emails tab + chat),
-- netlify/functions/mailbox-sync-background.ts + poll-mailboxes.ts (reading new mail).
-- Drizzle mirror: db/schema.ts (mailboxes, mailboxMessages).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, before deploying the code that reads it.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-mailboxes                              (staging)
--   npm run db:migrate:apply -- --only z-mailboxes --url-var DATABASE_URL_PROD  (prod)
--
-- Why a new table and not workspace_integrations: that table is ONE row per workspace per provider and
-- every owner/admin sees it. A mailbox belongs to ONE person, a person may connect a business and a
-- personal mailbox from the same provider, and a personal mailbox must stay private even from the
-- workspace owner.
--
-- ⚠️ WHAT IS NEVER STORED: email bodies and attachments. mailbox_messages holds headers (sender,
-- subject, date) and what we derive (category, priority, a one-line summary). The body is fetched from
-- the mailbox when the user opens an email and is not written anywhere. tests/email-assistant.test.ts
-- asserts no body column exists.
--
-- Disconnecting a mailbox DELETES its row; mailbox_messages go with it (ON DELETE CASCADE).

BEGIN;

CREATE TABLE IF NOT EXISTS mailboxes (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the owner; only they see it
    provider         TEXT NOT NULL CHECK (provider IN ('outlook', 'gmail')),
    address          TEXT NOT NULL,
    display_name     TEXT,
    kind             TEXT NOT NULL DEFAULT 'business' CHECK (kind IN ('business', 'personal')),
    -- 'replies' = the Lead Generator's replies-and-bounces reading only (Mail.Read / gmail.readonly);
    -- 'inbox'   = the Email Assistant (Mail.ReadWrite + Mail.Send / gmail.modify).
    grant_level      TEXT NOT NULL DEFAULT 'inbox' CHECK (grant_level IN ('replies', 'inbox')),
    -- ⚠️ One vault key PER MAILBOX, never per workspace + provider (meta-vault-key-collides-per-org).
    vault_ref_key    TEXT NOT NULL UNIQUE,
    scopes           TEXT,                       -- what the provider actually granted, from the token response
    status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'needs_reconnect', 'admin_blocked', 'disconnected')),
    sync_cursor      TEXT,                       -- Graph delta link / Gmail historyId
    last_sync_at     TIMESTAMP,
    last_error       TEXT,                       -- a short reason, never email content
    sync_lock_until  TIMESTAMP,                  -- one reader at a time per mailbox
    settings         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- sender rules, private senders
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_owner_address_unique
    ON mailboxes (organisation_id, user_id, provider, lower(address));
CREATE INDEX IF NOT EXISTS mailboxes_org_user_idx ON mailboxes (organisation_id, user_id);
CREATE INDEX IF NOT EXISTS mailboxes_status_idx ON mailboxes (status);

CREATE TABLE IF NOT EXISTS mailbox_messages (
    id                   SERIAL PRIMARY KEY,
    mailbox_id           INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    provider_message_id  TEXT NOT NULL,
    thread_id            TEXT,                   -- Graph conversationId / Gmail threadId
    from_name            TEXT,
    from_address         TEXT,
    subject              TEXT,
    received_at          TIMESTAMP,
    is_read              BOOLEAN NOT NULL DEFAULT false,
    web_link             TEXT,                   -- opens the email in Outlook / Gmail
    category             TEXT,
    priority             TEXT CHECK (priority IN ('now', 'today', 'week', 'whenever')),
    summary              TEXT,                   -- one line, derived; never the body
    reason               TEXT,                   -- why this priority, one line
    sorted_by            TEXT NOT NULL DEFAULT 'pending'
                         CHECK (sorted_by IN ('pending', 'headers', 'sender_rule', 'ai', 'user', 'private')),
    removed_at           TIMESTAMP,              -- no longer in the inbox (moved or deleted in the mail app)
    created_at           TIMESTAMP NOT NULL DEFAULT now(),
    updated_at           TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (mailbox_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS mailbox_messages_mailbox_received_idx ON mailbox_messages (mailbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS mailbox_messages_pending_idx ON mailbox_messages (mailbox_id) WHERE sorted_by = 'pending';

-- Behind a flag until launch: only workspaces listed on it (or with it switched on) can connect a mailbox.
INSERT INTO feature_flags (key, enabled, rollout_percentage, description)
VALUES ('email_assistant', false, 0, 'Email Assistant (docs/email-assistant-plan.md): connect a mailbox, sort and summarise email. Add workspace ids to allowed_workspace_ids to test.')
ON CONFLICT (key) DO NOTHING;

-- The catalogue row. HIDDEN (is_active false), not Coming soon: a Coming-soon card is public, and the
-- public pages must not promise reading email until it is live (plan §8). A super admin changes its
-- status in Admin → Assistants — on staging, to Beta to test it.
INSERT INTO master_assistants (role_key, name, description, category, icon_key, icon_color, coming_soon, is_active, lifecycle_state)
VALUES ('email_assistant', 'Email Assistant',
        'Looks after your mailbox: sorts every new email into a category, says what needs you today, and sums each one up in a line. Works with Outlook; Gmail is coming soon. Nothing is sent or deleted unless you approve it.',
        'Administration', 'document', 'blue', false, false, 'draft')
ON CONFLICT (role_key) DO NOTHING;

COMMIT;
