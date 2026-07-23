-- db/follower-counts-manual.sql
-- Group A: manually-entered, date-stamped follower counts (LinkedIn) + a metadata cache column on
-- workspace_integrations so Threads/YouTube follower counts can be cached like the system-connection
-- platforms already are.
--
-- LinkedIn's member API does not expose a personal-profile follower count, so the only compliant
-- option is the user typing it in. Each entry is a NEW dated row (history), so growth over time is
-- preserved; the latest row is the "current" count. See netlify/functions/save-follower-count.ts
-- and get-follower-counts.ts.
--
-- Manual-apply migration (idempotent). Apply to staging + prod.

CREATE TABLE IF NOT EXISTS manual_follower_counts (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL,                                   -- 'linkedin' (only manual platform today)
  count            INTEGER NOT NULL CHECK (count >= 0),
  recorded_at      TIMESTAMP NOT NULL DEFAULT now(),
  entered_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Latest-first lookups per org+platform (the newest row is the current count).
CREATE INDEX IF NOT EXISTS manual_follower_counts_org_platform_idx
  ON manual_follower_counts (organisation_id, platform, recorded_at DESC);

-- Cache slot for the workspace_integrations-backed platforms (Threads, YouTube), mirroring the
-- followerCount/followerCountAt cache that system_connections already keeps in its metadata jsonb.
ALTER TABLE workspace_integrations ADD COLUMN IF NOT EXISTS metadata JSONB;
