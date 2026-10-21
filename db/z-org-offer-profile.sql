-- db/z-org-offer-profile.sql — "What does your business offer?" (Business Information ▸ Products & Services).
-- src/utils/offer-profile.ts, netlify/functions/org-products.ts (GET returns it, PATCH { offer } saves it).
-- Drizzle mirror: db/schema.ts (orgOfferProfile).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent.
--   npm run db:migrate:apply -- --only z-org-offer-profile.sql                              (staging)
--   npm run db:migrate:apply -- --only z-org-offer-profile.sql --url-var DATABASE_URL_PROD  (prod)
--
-- Safe to deploy ahead of: every read of this table is caught and falls back to a guess from the
-- business's own data (offer-profile.ts inferOffers). Only SAVING the answer needs the table.
--
-- One row per workspace, written only when the owner answers (or approves a chat card). offers is
-- the ticked kinds from OFFER_KINDS — 'bookings', 'menu' — and an EMPTY array is a real answer
-- ("neither"), distinct from no row ("not answered yet, guess").

BEGIN;

CREATE TABLE IF NOT EXISTS org_offer_profile (
    organisation_id integer PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
    offers          text[]  NOT NULL DEFAULT '{}',
    updated_by      integer REFERENCES users(id) ON DELETE SET NULL,
    updated_at      timestamp NOT NULL DEFAULT now()
);

COMMIT;
