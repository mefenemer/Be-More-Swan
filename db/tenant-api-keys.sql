-- db/tenant-api-keys.sql
-- Keys that let a tenant's OWN systems write into their audience.
-- Requires db/audience.sql (and organisations, users).
--
-- ── What this unlocks ───────────────────────────────────────────────────────────────────────────
-- Until now a subscriber could arrive two ways: the sign-up form, or a CSV. A shop that takes a
-- marketing tick at checkout, a booking system, a Zapier step — all of them had to become a person
-- exporting a spreadsheet once a week, which is how a list goes stale and how consent evidence gets
-- lost between the tick and the import.
--
-- ⚠️ THE KEY IS STORED AS A HASH, NEVER AS ITSELF. It is a bearer credential for writing into a
-- tenant's audience: anybody holding it can subscribe people. A database read, a backup, or a
-- support engineer glancing at a row must not be able to use one. `key_prefix` is the first few
-- characters, kept in clear ONLY so a tenant can tell two keys apart in a list — it is far too
-- short to be guessed back into the whole.
--
-- ⚠️ REVOKED, NOT DELETED. A revoked row keeps answering "this key existed and was turned off on
-- the 3rd", which is the question asked after something goes wrong. Deleting it turns that into
-- "we have never seen that key", which is the same answer as for a key that was never ours.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'audience_contacts') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/tenant-api-keys.sql requires db/audience.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only audience.sql   (then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS api_keys (
  id              SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'API key',
  -- sha256 of the whole key. The key itself is shown once, at creation, and never again.
  key_hash        TEXT NOT NULL,
  -- 'bms_live_a1b2c3' — enough to recognise, nowhere near enough to use.
  key_prefix      TEXT NOT NULL,
  -- Reserved. One scope ships ('audience:write'); the column exists so a second is a row and not a
  -- migration of every key — the same reservation audience_segments.kind made and later cashed in.
  scopes          TEXT NOT NULL DEFAULT 'audience:write',
  last_used_at    TIMESTAMP,
  revoked_at      TIMESTAMP,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- The lookup on every API request: hash the bearer token, find the row. Unique because two keys
-- hashing the same would mean one of them was a copy of the other.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uidx ON api_keys (key_hash);

-- The tenant's own list of keys.
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (organisation_id, created_at DESC);

-- Verify:
--   SELECT table_name FROM information_schema.tables WHERE table_name = 'api_keys';
