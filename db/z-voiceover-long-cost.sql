-- db/z-voiceover-long-cost.sql — the long-voiceover cost key (owner, 2026-11-19).
-- A voiceover is ai_voiceover (1 task) plus ai_voiceover_long for each further started 2,500 characters
-- (src/config/task-weights.ts voiceoverTasks). The baseline is 0: nobody pays more until a change raising it is
-- announced in Admin → Money → Task costs and its date (30+ days later, Terms 5.2) arrives.
-- Safe to run more than once. Also in db/z-task-costs.sql's baseline list.
BEGIN;
INSERT INTO task_cost_change_items (change_id, cost_key, new_units)
VALUES (1, 'ai_voiceover_long', 0)
ON CONFLICT (change_id, cost_key) DO NOTHING;
COMMIT;

-- Check: expect 1.
-- SELECT count(*) FROM task_cost_change_items WHERE change_id = 1 AND cost_key = 'ai_voiceover_long';
