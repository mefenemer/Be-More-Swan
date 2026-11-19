-- db/z-meeting-pickup-flag.sql — the Note Taker picks up Google Meet calls by itself (docs/meeting-apps-pickup-plan.md).
-- OFF for everyone. Turn on per workspace (allowed_workspace_ids) for testing; for everyone only after Google approves
-- the meetings.space.readonly scope AND the 30-day Terms notice for the new meeting_pickup charge has run.
-- Gates: the Connect button and its OAuth start (oauth-integrations.ts), the Connections tab section (integrations.ts),
-- and which workspaces the 15-minute check reads (meeting-sources/google-meet.ts). Apply to BOTH databases. Idempotent.
INSERT INTO feature_flags (key, enabled, rollout_percentage, allowed_workspace_ids, description)
VALUES ('meeting_pickup', FALSE, 0, NULL,
        'Note Taker: pick up Google Meet calls with a transcript automatically (1 task each). Customers only after Google approves meetings.space.readonly and the Terms notice has run.')
ON CONFLICT (key) DO NOTHING;
