-- db/z-mailbox-push.sql — new mail arrives by push, not only by the 10-minute poll
-- (docs/email-assistant-plan.md §4.2–4.3, Phase 3b).
-- Code: src/utils/mailbox-push.ts, netlify/functions/mail-push-gmail.ts, netlify/functions/mail-push-graph.ts.
-- Drizzle mirror: db/schema.ts (mailboxes).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE deploying the code that reads it
-- (drizzle selects every column of mailboxes, so the code fails on a DB without these).
-- Idempotent: safe to re-run. ORDER: after z-mailboxes.sql.
--   npm run db:migrate:apply -- --only z-mailbox-push                              (staging)
--   npm run db:migrate:apply -- --only z-mailbox-push --url-var DATABASE_URL_PROD  (prod)
--
-- watch_expires_at  when the mailbox's push stops unless renewed (Gmail watch / Graph subscription,
--                   both at most 7 days). NULL = no push; the poll reads it every 10 minutes.
-- watch_id          the Graph subscription id (NULL for Gmail, whose watch has no id).
-- last_push_at      the last push for this mailbox; a watched mailbox is still polled every 30 minutes
--                   in case a push is lost.
--
-- Nothing from an email is stored here.

BEGIN;

ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS watch_expires_at TIMESTAMP;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS watch_id TEXT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS last_push_at TIMESTAMP;

-- mail-push-graph.ts finds the mailbox by its subscription id.
CREATE INDEX IF NOT EXISTS mailboxes_watch_id_idx ON mailboxes (watch_id) WHERE watch_id IS NOT NULL;
-- mail-push-gmail.ts finds Gmail mailboxes by address.
CREATE INDEX IF NOT EXISTS mailboxes_gmail_address_idx ON mailboxes (lower(address)) WHERE provider = 'gmail';

COMMIT;
