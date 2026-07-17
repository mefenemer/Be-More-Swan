-- CRM contact-request management — threaded correspondence for a lead.
-- Drizzle mirror: db/schema.ts::leadReplies. Powers the Sales Pipeline reply slide-over
-- and the inbound-email webhook (netlify/functions/inbound-email.ts).
--
-- The "customer" on a lead may be an anonymous prospect (contact form / inbound email) with
-- no users row, so author_id is nullable and `direction` records who sent each message:
--   inbound  = from the prospect (contact form submission or received email)
--   outbound = admin reply, emailed to the prospect via Resend
--   internal = private admin note, never emailed
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

CREATE TABLE IF NOT EXISTS lead_replies (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL DEFAULT 'inbound',
  author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT lead_replies_direction_check
    CHECK (direction IN ('inbound','outbound','internal'))
);

-- Hot path: the detail slide-over loads a lead's full thread oldest-first.
CREATE INDEX IF NOT EXISTS lead_replies_lead_idx
  ON lead_replies (lead_id, created_at);
