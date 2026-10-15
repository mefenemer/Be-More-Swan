-- db/z-chat-attachments.sql — files attached to an assistant chat (first: the Website Assistant).
-- Code: netlify/functions/chat-orchestrator.ts (accepts them), src/components/chat-session.js
-- (paperclip, drag and drop, paste), netlify/functions/sites.ts `words` (places an attached
-- document's text on a page word for word). Drizzle mirror: db/schema.ts (chatAttachments).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-chat-attachments.sql                              (staging)
--   npm run db:migrate:apply -- --only z-chat-attachments.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── chat_attachments ───────────────────────────────────────────────────────
-- kind 'image'    → asset_id: the picture, uploaded into the workspace's media library first
--                   (content_assets), so it can be used anywhere afterwards.
-- kind 'document' → text: what was read from the Word / PDF / text file. The FILE is not kept; its
--                   words are, so a later "put that on the About page" places exactly them.
-- Rows belong to one conversation and one organisation; every reader scopes by organisation_id.

BEGIN;

CREATE TABLE IF NOT EXISTS chat_attachments (
    id                SERIAL PRIMARY KEY,
    organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    chat_session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    chat_message_id   INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('image', 'document')),
    asset_id          INTEGER REFERENCES content_assets(id) ON DELETE SET NULL,
    name              TEXT NOT NULL,
    text              TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_attachments_session_idx ON chat_attachments (chat_session_id, created_at);
CREATE INDEX IF NOT EXISTS chat_attachments_org_idx ON chat_attachments (organisation_id);

COMMIT;
