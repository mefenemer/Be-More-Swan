-- db/review-links.sql: free guest review links (docs/review-link-plan.md).
--
-- A subscriber shares one piece of work through a private link, and a guest with no account approves
-- it or asks for changes. No guest email or IP address is stored, and the token itself never is.
--
-- Apply on staging, then prod, BEFORE the code. Safe to re-run. Each statement that touches an existing
-- row RETURNs, so the Neon SQL editor shows a result either way.

BEGIN;

CREATE TABLE IF NOT EXISTS review_links (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  item_kind        TEXT NOT NULL CHECK (item_kind IN ('social_post','design_brief')),
  item_id          INTEGER NOT NULL,          -- a post in the cross-post group, or a visual_briefs id
  token_hash       TEXT NOT NULL UNIQUE,      -- sha256; the token itself is never stored
  label            TEXT,                      -- subscriber's own note, e.g. "for Sarah"
  expires_at       TIMESTAMP NOT NULL,
  revoked_at       TIMESTAMP,
  view_count       INTEGER NOT NULL DEFAULT 0,
  first_viewed_at  TIMESTAMP,
  trial_clicks     INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_links_item ON review_links (organisation_id, item_kind, item_id);

CREATE TABLE IF NOT EXISTS review_link_responses (
  id               SERIAL PRIMARY KEY,
  link_id          INTEGER NOT NULL REFERENCES review_links(id) ON DELETE CASCADE,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  guest_name       TEXT NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('approved','changes','comment')),
  option_id        INTEGER,                   -- the design option chosen, if any
  body             TEXT,
  content_hash     TEXT NOT NULL,             -- what they were looking at
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_link_responses_link ON review_link_responses (link_id, created_at);

COMMIT;
