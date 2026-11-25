-- db/z-meeting-bot-blocked-flag.sql — a per-workspace switch-OFF for the Note Taker meeting bot (25 November 2026)
--
-- The sub-processor notice for Recall.ai promises owners: "ask us at privacy@bemoreswan.com and we will switch the Note
-- Taker's meeting feature off for your workspace" (review of #867). Feature flags can only add workspaces, so this flag's
-- allow-list IS the block list (src/utils/meeting-bot.ts MEETING_BOT_BLOCK_FLAG, meeting-bot-db.ts meetingBotAvailable).
--
--   Block a workspace — in this order, because bots already BOOKED are scheduled at Recall and still join:
--     1. Cancel its open bots first (the owner, or support access, presses Cancel / Remove from call in the Note Taker's
--        Live & upcoming list; once blocked, that list is hidden). Check none are left:
--          SELECT id, status, join_at FROM meeting_bots WHERE organisation_id = <org_id>
--            AND status IN ('scheduled','joining','waiting_room','in_call');
--     2. UPDATE feature_flags SET allowed_workspace_ids = array_append(COALESCE(allowed_workspace_ids, '{}'), <org_id>)
--          WHERE key = 'meeting_bot_blocked';
--   Keep enabled FALSE: TRUE blocks EVERY workspace (an emergency kill switch, whatever rollout_percentage says;
--   meeting-bot-db.ts meetingBotBlocked reads the row itself, and an unreadable row counts as blocked).
--
-- Additive and idempotent. Run on BOTH databases before the release that ships #864.

INSERT INTO feature_flags (key, enabled, rollout_percentage, allowed_workspace_ids, description)
VALUES ('meeting_bot_blocked', FALSE, 0, NULL,
        'Note Taker meeting bot BLOCK list: workspaces listed here cannot send the bot even when meeting_bot is on (owner asked to switch it off). Leave enabled OFF; ON blocks every workspace.')
ON CONFLICT (key) DO NOTHING;

-- Read back:
-- SELECT key, enabled, rollout_percentage, allowed_workspace_ids FROM feature_flags WHERE key = 'meeting_bot_blocked';
