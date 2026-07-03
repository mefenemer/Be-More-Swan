-- Business-domain organisation grouping (#2).
--
-- Adds to organisations:
--   business_domain    text     — owner's non-public email host (null for gmail/outlook/…)
--   domain_verified    boolean  — reserved for future DNS/email domain-ownership verification
--   allow_domain_join  boolean  — owner opt-in: same-domain signups join this org
--
-- Auto-join only happens for a NON-public business_domain on an org with
-- domain_verified = true AND allow_domain_join = true (see register.ts + src/utils/email-domain.ts).
-- Public providers never match, so unrelated users are never merged into one tenant.
--
-- APPLY THIS FILE (Neon SQL editor / psql as owner) — do NOT use `drizzle-kit push`.
-- Plain ALTERs cannot touch RLS; new columns inherit grants + row policies. Idempotent.

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS business_domain   text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS domain_verified   boolean NOT NULL DEFAULT false;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS allow_domain_join boolean NOT NULL DEFAULT false;

-- Speeds up the registration lookup "is there a joinable org for this domain?"
CREATE INDEX IF NOT EXISTS organisations_business_domain_idx
    ON organisations (business_domain) WHERE business_domain IS NOT NULL;
