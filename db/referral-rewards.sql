-- Migration: Referral Program Expansion (token vault + bonus assistants).
-- Applied manually (like db/onboarding-drafts-multidraft.sql) rather than via `drizzle-kit push`,
-- which would also try to DISABLE RLS on ai_assistants (RLS lives in db/rls/, untracked by drizzle).
-- Idempotent: safe to re-run.

-- AC2.2: extra assistant slots that stack on top of the Stripe tier limit.
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS bonus_assistants integer NOT NULL DEFAULT 0;

-- AC2.3: redemption ledger — audit trail + double-spend guard.
CREATE TABLE IF NOT EXISTS reward_redemptions (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organisation_id integer REFERENCES organisations(id) ON DELETE CASCADE,
  type text NOT NULL,                       -- 'credit_10' | 'free_assistant'
  tokens_spent integer NOT NULL,
  stripe_balance_tx_id text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reward_redemptions_user_idx ON reward_redemptions(user_id);

-- Note: user_referrals.status gains a 'spent' value (free-text column — no DDL needed).
--   pending → qualified (token earned) → spent (token consumed). Legacy 'rewarded' rows
--   (already auto-credited £10) are left untouched and excluded from token math.
