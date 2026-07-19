-- Resumable-upload state for scheduled YouTube posts.
-- Drizzle mirror: db/schema.ts::scheduledPosts.youtubeUploadState.
--
-- A YouTube upload cannot be assumed to fit in one function invocation. The driver
-- (src/utils/social-publish.ts::publishYouTubeResumable) chunks the transfer and, when its
-- wall-clock budget runs out, stops at a chunk boundary and hands back
-- { uploadUrl, total, offset }. Parking that here lets the NEXT invocation of
-- publish-youtube-background carry on instead of restarting a multi-hundred-MB video from zero.
--
-- Shape: { "uploadUrl": "https://…", "total": 123456789, "offset": 8388608 }
--   uploadUrl — the resumable session YouTube handed us (valid ~1 week, so it outlives any retry
--               schedule we would sensibly use).
--   total     — the source's byte length, needed for every Content-Range header.
--   offset    — advisory only. A resume always re-queries the session for the authoritative
--               offset first, because an invocation can be killed after YouTube stored a chunk
--               but before we managed to write this row.
--
-- NULL means "no upload in flight": either it never started, or it finished, or it failed and the
-- session was abandoned. Cleared on success AND on terminal failure — a stale session URL here
-- would make the next attempt resume into a video the user has since edited.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS youtube_upload_state JSONB;

-- The resume path looks up "YouTube posts with an upload already in flight". Partial index: this
-- column is NULL for essentially every row, including all non-YouTube posts.
CREATE INDEX IF NOT EXISTS scheduled_posts_youtube_upload_state_idx
  ON scheduled_posts (id)
  WHERE youtube_upload_state IS NOT NULL;

COMMENT ON COLUMN scheduled_posts.youtube_upload_state IS
  'In-flight YouTube resumable-upload session { uploadUrl, total, offset }. NULL = nothing in flight.';
