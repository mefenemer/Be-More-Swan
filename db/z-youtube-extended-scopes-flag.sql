-- db/z-youtube-extended-scopes-flag.sql — the switch for YouTube caption tracks and the drop-off curve (11 November 2026)
--
-- src/lib/youtube-extras.ts: caption tracks need youtube.force-ssl and the drop-off curve needs
-- yt-analytics.readonly. Both are sensitive scopes Google must approve, and every connected channel must
-- reconnect to grant them. While this flag is OFF (the default here), the YouTube consent screen asks for
-- exactly what it does today (upload + readonly), so nothing changes for anyone.
--
-- Turn it on in Admin → Feature flags once Google has approved the two scopes:
--   · allowed_workspace_ids = '{58}' first (the review workspace) to film the scope demo for Google,
--   · then enabled = TRUE, rollout_percentage = 100 for everyone.
-- Thumbnails, views/likes/comments and caption files to download don't need it.
--
-- Safe to re-run: never changes a flag that already exists. Apply to BOTH databases with the release.

INSERT INTO feature_flags (key, enabled, rollout_percentage, allowed_workspace_ids, description)
VALUES ('youtube_extended_scopes', FALSE, 0, NULL,
        'YouTube: ask for caption-track (youtube.force-ssl) and analytics (yt-analytics.readonly) access when a channel connects. Turn on only after Google approves both scopes; channels must reconnect.')
ON CONFLICT (key) DO NOTHING;

-- Check (expect one row, enabled = f):
-- SELECT key, enabled, rollout_percentage, allowed_workspace_ids FROM feature_flags WHERE key = 'youtube_extended_scopes';
