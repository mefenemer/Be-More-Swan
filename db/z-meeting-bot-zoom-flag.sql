-- db/z-meeting-bot-zoom-flag.sql — the Note Taker's bot joins ZOOM calls (docs/note-taker-bot-plan.md step 4,
-- docs/zoom-marketplace-review-pack.md). OFF for everyone; absent already means off, this row only makes it switchable.
-- Gates: Connect Zoom (oauth-integrations.ts), the Zoom line in the "Send to a call" dialog (meeting-bots.ts GET),
-- sending a bot to a Zoom link (meeting-bot-db.ts sendMeetingBot) and the OBF token URL (zoom-obf-token.ts).
-- Turn on per workspace (allowed_workspace_ids) to test with our own Zoom app's development credentials, which only
-- reach meetings on Be More Swan's own Zoom account; for everyone only after Zoom approves the app.
-- Apply to BOTH databases. Idempotent.
INSERT INTO feature_flags (key, enabled, rollout_percentage, allowed_workspace_ids, description)
VALUES ('meeting_bot_zoom', FALSE, 0, NULL,
        'Note Taker bot: join Zoom calls on behalf of the connected Zoom user (OBF). Customers only after Zoom approves our Marketplace app.')
ON CONFLICT (key) DO NOTHING;
