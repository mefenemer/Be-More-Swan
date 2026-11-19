-- db/z-meeting-bots-assistant-set-null.sql — a Note Taker's meeting bot rows survive the assistant being purged
-- (docs/note-taker-bot-plan.md; review round 3 of #769). Follows db/z-meeting-bots.sql, which created the link as
-- ON DELETE CASCADE: purging an archived Note Taker deleted its bot rows while Recall could still hold the bot, so it
-- would join a call untracked (webhooks ignored, recording never deleted). With SET NULL the row stays, the 15-minute
-- poll keeps tracking it and deletes Recall's copy. (Archive and purge also withdraw bots first: withdrawMeetingBots.)
--
-- APPLY MANUALLY, staging and prod separately. Idempotent (drop + add of the same constraint, in one transaction).

BEGIN;
ALTER TABLE meeting_bots DROP CONSTRAINT IF EXISTS meeting_bots_ai_assistant_id_fkey;
ALTER TABLE meeting_bots ADD CONSTRAINT meeting_bots_ai_assistant_id_fkey
    FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE SET NULL;
COMMIT;

-- Check: expect 'n' (SET NULL).
-- SELECT confdeltype FROM pg_constraint WHERE conname = 'meeting_bots_ai_assistant_id_fkey';
