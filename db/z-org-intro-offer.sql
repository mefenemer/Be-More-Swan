-- db/z-org-intro-offer.sql — "Do you offer a free trial or an introductory offer?"
-- (Business Information ▸ Products & Services). src/utils/intro-offer.ts,
-- netlify/functions/org-products.ts (GET returns it, PATCH { introOffer } saves it).
-- Drizzle mirror: db/schema.ts (orgIntroOffer).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent.
--   npm run db:migrate:apply -- --only z-org-intro-offer.sql                              (staging)
--   npm run db:migrate:apply -- --only z-org-intro-offer.sql --url-var DATABASE_URL_PROD  (prod)
--
-- Safe to deploy ahead of: every read is caught and treated as "not answered" (assistants are
-- told not to promise an offer). Only SAVING the answer needs the table (503 until applied).
--
-- One row per workspace, written only when the owner answers (or approves a chat card). offer is
-- the cleaned answer (intro-offer.ts cleanIntroOffer): { "has": false } is a real answer ("no"),
-- distinct from no row ("not answered yet").

BEGIN;

CREATE TABLE IF NOT EXISTS org_intro_offer (
    organisation_id integer PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
    offer           jsonb   NOT NULL,
    updated_by      integer REFERENCES users(id) ON DELETE SET NULL,
    updated_at      timestamp NOT NULL DEFAULT now()
);

COMMIT;
