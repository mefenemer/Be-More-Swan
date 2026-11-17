-- db/z-ai-presenter.sql — the AI presenter's switch and price (17 November 2026)
--
-- docs/video-producer-screen-walkthrough-plan.md §11 (Phase A2). A made-up person (src/public/presenter-catalogue.json)
-- speaks a video's script to camera. Two rows, both additive and safe to re-run:
--
--   · feature_flags 'ai_presenter', OFF. While it is off, the Videos tab shows no presenter field, the chat lists no
--     presenters, and video-projects strips a presenter from any brief (src/lib/presenters.ts AI_PRESENTER_FLAG).
--     ⚠️ Decision D-A3 makes this a NEW charge: switch it on for customers only after the Terms 30-day notice
--     (clause 20.2) for the per-second price has run. Until then, allowed_workspace_ids can list test workspaces.
--   · task cost 'ai_presenter' = 2 tasks per second on screen, on the baseline change (the same row
--     db/z-task-costs.sql now carries, so a fresh database gets it either way). Admin → Money → Task costs can change it.
--
-- Apply to BOTH databases with the release that carries A2.

INSERT INTO feature_flags (key, enabled, rollout_percentage, allowed_workspace_ids, description)
VALUES ('ai_presenter', FALSE, 0, NULL,
        'Video Producer: an AI presenter (made-up person) speaks the script to camera, 2 tasks per second on screen. Turn on for customers only after the Terms 30-day notice for the price has run.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO task_cost_change_items (change_id, cost_key, new_units) VALUES
    (1, 'ai_presenter', 2)
ON CONFLICT (change_id, cost_key) DO NOTHING;

-- Check (expect enabled = f and one cost row of 2):
-- SELECT key, enabled, allowed_workspace_ids FROM feature_flags WHERE key = 'ai_presenter';
-- SELECT cost_key, new_units FROM task_cost_change_items WHERE change_id = 1 AND cost_key = 'ai_presenter';
