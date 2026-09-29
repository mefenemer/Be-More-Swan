-- The curated music library: tracks we licensed ourselves and host ourselves.
--
-- Drizzle mirror: db/schema.ts::musicTracks. Rules: src/lib/music-library.ts.
--
-- ── Why a table and not a stock provider ────────────────────────────────────────────────────────
-- Every other media source here is somebody else's search API (src/utils/pexels.ts). Music is not,
-- and the reason is whose risk it is. A customer publishes commercially; if a track turns out to be
-- licensed for non-commercial use, or the provider changes its terms, or withdraws a file, the
-- exposure lands on them and on us. A library we licensed once and can produce the paperwork for is
-- one we can answer for. It also removes three failure modes the stock path lives with: rate limits,
-- a third-party CDN that has to be reachable at render time, and terms about hotlinking — Remotion
-- fetches from our own storage exactly as it does for an uploaded voice note.
--
-- ── Why the licence is COLUMNS and not a jsonb blob ─────────────────────────────────────────────
-- Because it is queried and because it is the part we are answerable for. Which tracks may be
-- offered to an organisation that publishes without credits is a WHERE clause, not a filter in
-- application code that a second caller can forget. A blob would also make an expiry invisible to
-- anything but a full scan, and an expiry that nobody can see is an expiry nobody honours.
--
-- ⚠️ attribution_required is NOT a preference and must never be joined to one. Pexels credits are a
-- courtesy this product offers per organisation (creditLine, opt-in). A licence that DEMANDS a credit
-- is a condition of use: an organisation with credits switched off must not be OFFERED those tracks
-- at all, because publishing one uncredited is a breach committed on the customer's account. The two
-- look identical in a settings panel, which is exactly how they get conflated.
--
-- ⚠️ Withdrawal and expiry are not retroactive. A row is never deleted and is_active is never used to
-- hide a track from a post that already carries it: posts published last month were licensed when
-- they went out. Both flags stop a track being OFFERED; content_assets rows and audio_overlays
-- referencing it keep resolving. See usableTracks() in src/lib/music-library.ts.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push), to BOTH staging
-- and prod BEFORE the code that selects it ships — db.select() names every column, so a missing
-- table breaks the Sound layer's read path.

CREATE TABLE IF NOT EXISTS music_tracks (
  id                    serial PRIMARY KEY,

  title                 text        NOT NULL,
  artist                text        NOT NULL,

  -- OUR storage, never a third party's. storage_key is the object; url is what the browser and the
  -- renderer fetch. Both, because a signed or moved bucket changes the url and not the object.
  storage_key           text,
  url                   text        NOT NULL,

  -- ⚠️ STORED, not measured. A clip's length is measured in the browser because Pexels supplies
  -- none, and that measurement failing is what once removed the trim slider from a correct-looking
  -- timeline (db/content-asset-duration.sql, and _pceTrimAxis). We control ingestion here, so there
  -- is no excuse for not knowing: the picker states a length before anything has been fetched.
  duration_s            real        NOT NULL,

  -- Mood and genre, lower-case. Free-form on purpose — curation is a human job and a fixed
  -- vocabulary would be wrong within a month.
  tags                  text[]      NOT NULL DEFAULT '{}',

  -- ── Licence ──────────────────────────────────────────────────────────────────────────────────
  -- Stored as the vendor words it. Paraphrasing a licence name or a credit line is how a legal
  -- string becomes an approximation of one.
  licence_name          text        NOT NULL,
  licence_terms_url     text,
  -- Defaults TRUE: an unrecorded licence is treated as the stricter one. Crediting a track that did
  -- not need it costs a line of caption; not crediting one that did is a breach.
  attribution_required  boolean     NOT NULL DEFAULT true,
  attribution_text      text,
  -- NULL = perpetual. A date, not a timestamp: licences run to a day, not to an instant.
  licence_expires_at    date,

  -- ── Provenance ───────────────────────────────────────────────────────────────────────────────
  -- Where it came from and what we hold. Not used by any code path — it is the answer to "prove you
  -- may use this", which is the entire argument for owning the library rather than borrowing it.
  source                text,
  source_reference      text,
  acquired_at           timestamptz NOT NULL DEFAULT now(),

  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- The picker's only query: what may be offered, right now. Partial, because the inactive and expired
-- rows are kept forever and never selected — they exist so published posts keep resolving.
CREATE INDEX IF NOT EXISTS music_tracks_offerable_idx
  ON music_tracks (attribution_required, duration_s)
  WHERE is_active;

-- Filtering by mood is the one thing a person actually does in a music picker.
CREATE INDEX IF NOT EXISTS music_tracks_tags_idx ON music_tracks USING GIN (tags);

-- A track is identified by where its bytes are. Two rows pointing at one object is a curation
-- mistake that would show the same bed twice in the picker under two names.
CREATE UNIQUE INDEX IF NOT EXISTS music_tracks_url_key ON music_tracks (url);
