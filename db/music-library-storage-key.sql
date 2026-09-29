-- music_tracks: a track is identified by its OBJECT, not by a URL.
--
-- Corrects db/music-library.sql, which gave the table `url NOT NULL UNIQUE` and made storage_key
-- optional. That was the wrong way round, and reading the render path is what showed it:
--
--   resolveAudioTracks (src/lib/post-render.ts) resolves an audio asset by presigning its
--   storageKey for an hour, and only falls back to external_url when there is no key. R2 objects
--   here are PRIVATE — every other audio asset in the product is served that way, and the browser
--   gets a signed URL minted on demand.
--
-- So a durable public `url` is not something a library track has. Storing one would have meant
-- either making the bucket public — for files we have paid to licence — or keeping a column that is
-- always null while the unique index sat on it, silently permitting duplicate objects.
--
-- Applied while both databases held zero rows, which is the only reason this is a plain ALTER rather
-- than a backfill.
--
-- ⚠️ Deliberately a NEW file rather than an edit to music-library.sql. A migration that has already
-- been applied is history; editing it in place means the two databases and the repo disagree about
-- what was run, and the runner re-runs drifted files. See db/_migrations-tracking.sql.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner to BOTH staging and prod BEFORE the
-- code that selects it ships — db.select() names every column.

-- Order-independent: the runner sorts `-` before `.`, so on a FRESH database this file runs BEFORE
-- music-library.sql creates the table. Everything is therefore guarded on the table existing, and
-- the create in music-library.sql already carries the final shape — this file only corrects a table
-- still in the old one.
ALTER TABLE IF EXISTS music_tracks
  ALTER COLUMN storage_key SET NOT NULL;

-- The object is the identity. Two rows pointing at one file is a curation mistake that would show
-- the same bed twice in the picker under two names.
DROP INDEX IF EXISTS music_tracks_url_key;
DO $$
BEGIN
  IF to_regclass('music_tracks') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS music_tracks_storage_key_key ON music_tracks (storage_key);
  END IF;
END $$;

-- Nothing reads it, nothing can populate it honestly, and a nullable column under a unique index is
-- how duplicates get in.
ALTER TABLE IF EXISTS music_tracks
  DROP COLUMN IF EXISTS url;
