-- db/z-meeting-bot-free-until-2027.sql — the Note Taker's meeting bot is free until 1 January 2027 (25 November 2026)
--
-- Owner decision 2026-11-25 (fast launch, docs/note-taker-launch-notices-draft.md): the bot launches on 27 November
-- 2026 for workspaces that accept DPA 1.2, FREE; the charge of 1 task per started 5 minutes starts on 1 January 2027
-- after the Terms 5.2 30-day notice (Admin → Money → Task costs, announced 25 November).
--
-- db/z-meeting-bots.sql seeded meeting_bot_call = 1 on the baseline. Nobody has been charged on prod (flag meeting_bot
-- OFF there); staging charged only test org 58. Admin's "set before anyone is charged" button refuses this key
-- (costInUse), so this file records the same row that button would: a baseline change, now, 1 → 0. The announced
-- 0 → 1 change for 2027-01-01 is then made in Admin and shows customers "no tasks until 1 January 2027".
--
-- Idempotent: does nothing once a later change has already set meeting_bot_call to 0. Run on BOTH databases BEFORE
-- announcing the 0 → 1 change in Admin.

DO $$
DECLARE new_id integer;
BEGIN
    IF EXISTS (
        SELECT 1 FROM task_cost_change_items i JOIN task_cost_changes c ON c.id = i.change_id
        WHERE i.cost_key = 'meeting_bot_call' AND i.new_units = 0 AND c.status IN ('baseline', 'announced')
    ) THEN
        RAISE NOTICE 'meeting_bot_call already set to 0 — nothing to do';
        RETURN;
    END IF;
    INSERT INTO task_cost_changes (status, effective_from, reason, created_by)
    VALUES ('baseline', (now() AT TIME ZONE 'UTC'), 'Note Taker meeting bot: free until the 1 January 2027 charge (set before anyone is charged).', NULL)
    RETURNING id INTO new_id;
    INSERT INTO task_cost_change_items (change_id, cost_key, old_units, new_units)
    VALUES (new_id, 'meeting_bot_call', 1, 0);
END $$;

-- Read back:
-- SELECT c.id, c.status, c.effective_from::text, i.old_units, i.new_units
--   FROM task_cost_change_items i JOIN task_cost_changes c ON c.id = i.change_id
--  WHERE i.cost_key = 'meeting_bot_call' ORDER BY c.effective_from;
