-- Referral Invites — sent-invite lifecycle tracking.
--
-- Records each referral link emailed to a friend (referral-share.ts) so the sender can
-- see "Invited — awaiting sign-up" in their Referral Activity BEFORE the friend registers.
-- A user_referrals row requires referred_user_id (the friend's account), so it cannot
-- represent an unaccepted invite — this table fills that gap. On registration via the
-- link (register.ts), the matching invite is marked 'accepted' and linked to the new user.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see
-- the no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS referral_invites (
  id               SERIAL PRIMARY KEY,
  referrer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,                       -- invited friend's email (stored lowercased)
  referral_code    TEXT NOT NULL,                       -- the code that was shared
  status           TEXT NOT NULL DEFAULT 'invited',     -- 'invited' | 'accepted'
  accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at          TIMESTAMP NOT NULL DEFAULT now(),
  accepted_at      TIMESTAMP
);

-- One invite row per (referrer, email); re-sending updates sent_at via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS referral_invites_referrer_email_unique
  ON referral_invites (referrer_id, email);

CREATE INDEX IF NOT EXISTS referral_invites_referrer_idx
  ON referral_invites (referrer_id);

-- Functional index to support case-insensitive email matching on registration.
CREATE INDEX IF NOT EXISTS referral_invites_email_lower_idx
  ON referral_invites (lower(email));

-- Constrain status to the known lifecycle values (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referral_invites_status_check'
  ) THEN
    ALTER TABLE referral_invites
      ADD CONSTRAINT referral_invites_status_check CHECK (status IN ('invited', 'accepted'));
  END IF;
END $$;
