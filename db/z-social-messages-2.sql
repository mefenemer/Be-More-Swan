-- db/z-social-messages-2.sql — Facebook + Instagram messages, Phase 2 (docs/meta-messages-plan.md):
-- the Messages tab, Send, and the "4 hours left" reminder. Adds four columns to social_conversations.
-- Drizzle mirror: db/schema.ts (socialConversations).
--
-- APPLY MANUALLY, staging and prod separately, BEFORE the Phase 2 code deploys (needs
-- db/z-social-messages.sql first). Idempotent. Additive only.
--
-- reminded_for_window: the window_closes_at the reminder was sent for. A new message from the person
--   moves window_closes_at, so the next window gets its own reminder; one per window, never repeated.
-- name_looked_up_at: when Meta was last asked for the person's name; a refusal isn't retried for a day.
-- decided_by / decided_at: who dismissed the conversation (or put it back), and when.

BEGIN;

ALTER TABLE social_conversations ADD COLUMN IF NOT EXISTS reminded_for_window TIMESTAMP;
ALTER TABLE social_conversations ADD COLUMN IF NOT EXISTS name_looked_up_at TIMESTAMP;
ALTER TABLE social_conversations ADD COLUMN IF NOT EXISTS decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE social_conversations ADD COLUMN IF NOT EXISTS decided_at TIMESTAMP;

-- The reminder sweep: waiting conversations whose window ends soon.
CREATE INDEX IF NOT EXISTS social_conversations_window_idx ON social_conversations (status, window_closes_at);

COMMIT;

-- Check: expect 4 rows.
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'social_conversations'
--   AND column_name IN ('reminded_for_window', 'name_looked_up_at', 'decided_by', 'decided_at');
