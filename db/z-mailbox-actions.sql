-- db/z-mailbox-actions.sql — what the Email Assistant proposes and the user approves (docs/email-assistant-plan.md
-- §2.4–2.5, Phase 2a): drafted replies, and clean-up batches (archive / move to trash), with Undo.
-- Code: src/utils/mailbox-actions.ts, src/utils/mail-writer/, netlify/functions/mailboxes.ts.
-- Drizzle mirror: db/schema.ts (mailboxActions).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, before deploying the code that reads it.
-- Idempotent: safe to re-run. ORDER: after z-mailboxes.sql.
--   npm run db:migrate:apply -- --only z-mailbox-actions                              (staging)
--   npm run db:migrate:apply -- --only z-mailbox-actions --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ Only the mailbox's OWNER ever reads these (user_id). Not assistant_records: those are shown to every
-- workspace member with access to the assistant, and a drafted reply quotes someone's email.
--
-- ⚠️ WHAT IS STORED: a drafted reply's text (until it is sent or dismissed, then 30 days for the
-- activity list), and for clean-up the message ids and where each one was (labels / folder) so Undo can
-- put it back. Never the email being replied to. poll-mailboxes.ts deletes rows 30 days after they were
-- acted on, or dismissed. Disconnecting the mailbox deletes them all (ON DELETE CASCADE).
--
-- status: waiting   → proposed, waiting for the user
--         sent      → reply sent (kind reply)
--         drafted   → reply saved to the mailbox's own Drafts folder (kind reply)
--         applied   → clean-up done (kind cleanup)
--         undone    → clean-up put back
--         dismissed → the user said no
--         failed    → the provider refused; `result.error` says why

BEGIN;

CREATE TABLE IF NOT EXISTS mailbox_actions (
    id               SERIAL PRIMARY KEY,
    mailbox_id       INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('reply', 'cleanup')),
    status           TEXT NOT NULL DEFAULT 'waiting'
                     CHECK (status IN ('waiting', 'sent', 'drafted', 'applied', 'undone', 'dismissed', 'failed')),
    message_id       INTEGER REFERENCES mailbox_messages(id) ON DELETE SET NULL,  -- the email replied to (reply)
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    result           JSONB,
    acted_at         TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mailbox_actions_mailbox_status_idx ON mailbox_actions (mailbox_id, status);
CREATE INDEX IF NOT EXISTS mailbox_actions_user_idx ON mailbox_actions (organisation_id, user_id);
-- One reply being worked on per email at a time (a second "Draft reply" reopens the first).
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_actions_one_waiting_reply
    ON mailbox_actions (message_id) WHERE kind = 'reply' AND status = 'waiting';

COMMIT;
