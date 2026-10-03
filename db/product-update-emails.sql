-- db/product-update-emails.sql
-- The weekly "What's new at Be More Swan" email (docs/weekly-product-update.md).
--
-- A weekly Claude task on the founder's Mac reads the week's commits on main, writes the copy,
-- screenshots the demo workspace and uploads the draft here. An admin reviews it in the portal
-- (Comms → What's New Emails) and nothing is sent until they press Approve & send.
--
-- ⚠️ APPLY BEFORE DEPLOYING the code. product-updates.ts reads these tables on every admin load and
-- on every upload; without them the upload fails and the admin page shows an error.
--
-- Idempotent and safe to re-run: CREATE ... IF NOT EXISTS throughout, no DROP.

-- ── One weekly email ───────────────────────────────────────────────────────────────────────────
-- status:  ready    → uploaded, waiting for an admin
--          sending  → approved; the background worker is delivering it
--          sent     → every recipient has a product_update_sends row
--          discarded→ an admin decided not to send it
CREATE TABLE IF NOT EXISTS product_update_digests (
  id               SERIAL PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'ready'
                   CHECK (status IN ('ready', 'sending', 'sent', 'discarded')),
  subject          TEXT NOT NULL,
  preheader        TEXT,
  intro            TEXT,
  -- [{ heading, body, imageId|null }] in display order. Copy is plain text; the renderer escapes it.
  items            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The commit window the copy was written from, so next week's run starts where this one stopped.
  commit_from      TEXT,
  commit_to        TEXT,
  period_start     DATE,
  period_end       DATE,
  reminder_sent_at TIMESTAMP,
  approved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMP,
  sent_at          TIMESTAMP,
  recipient_count  INTEGER,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_update_digests_status_idx ON product_update_digests (status, created_at DESC);

-- ── Its screenshots ────────────────────────────────────────────────────────────────────────────
-- Stored in the database, not R2: a week is ~7 screenshots of ~60 KB, and an email image must stay
-- loadable for years from a mail client with no session (R2 here is private and presigned URLs
-- die in minutes). Served by product-update-image.ts behind an HMAC-signed URL.
CREATE TABLE IF NOT EXISTS product_update_images (
  id         SERIAL PRIMARY KEY,
  digest_id  INTEGER NOT NULL REFERENCES product_update_digests(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data_b64   TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_update_images_digest_idx ON product_update_images (digest_id);

-- ── Who got it ─────────────────────────────────────────────────────────────────────────────────
-- One row per (digest, user), written BEFORE the send. The unique index is the idempotency guard:
-- a worker that is triggered twice, or retried after a timeout, can never email anyone twice.
CREATE TABLE IF NOT EXISTS product_update_sends (
  id         SERIAL PRIMARY KEY,
  digest_id  INTEGER NOT NULL REFERENCES product_update_digests(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  error      TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  sent_at    TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS product_update_sends_digest_user_uidx ON product_update_sends (digest_id, user_id);
