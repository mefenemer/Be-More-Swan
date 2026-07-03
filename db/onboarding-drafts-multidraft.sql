-- Migration: onboarding_drafts → multi-row (multiple in-progress drafts per user).
-- Applied manually (like db/rls/*.sql) rather than via `drizzle-kit push`, because a full
-- push would also try to DISABLE RLS on ai_assistants (RLS lives in raw SQL drizzle doesn't track).
-- Idempotent: safe to re-run.

-- New surrogate key + card/ownership metadata.
ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS id serial;
ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS organisation_id integer REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS role_key text;
ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS display_name text;

-- Switch the primary key from user_id (one draft/user) to the new serial id (many/user).
ALTER TABLE onboarding_drafts DROP CONSTRAINT IF EXISTS onboarding_drafts_pkey;
ALTER TABLE onboarding_drafts ADD PRIMARY KEY (id);

-- user_id stays NOT NULL (it was the PK); enforce explicitly now that the PK moved.
ALTER TABLE onboarding_drafts ALTER COLUMN user_id SET NOT NULL;

-- Lookup indexes for the card queries.
CREATE INDEX IF NOT EXISTS onboarding_drafts_user_idx ON onboarding_drafts(user_id);
CREATE INDEX IF NOT EXISTS onboarding_drafts_org_idx ON onboarding_drafts(organisation_id);
