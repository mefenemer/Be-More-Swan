-- db/z-reviews.sql — Business Information ▸ Reviews: the business's real reviews, recorded ONCE and
-- used everywhere (the Website Assistant's reviews section and its search data; later, assistants
-- quoting them). src/utils/reviews.ts, netlify/functions/org-reviews.ts.
-- Drizzle mirror: db/schema.ts (orgReviews).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-reviews.sql                              (staging)
--   npm run db:migrate:apply -- --only z-reviews.sql --url-var DATABASE_URL_PROD  (prod)
--
-- A review is the customer's words, word for word: who (author_name, optional author_detail such as
-- "Leeds" or "Wedding, June 2026"), the stars (rating 1–5, or NULL when the source has none), when
-- (reviewed_on) and where it was left (source — shown on the site as "Google review" etc.).
--
-- status: published (can be quoted) | hidden (not quoted, but STILL COUNTED in the average rating —
-- the rating stays honest: UK consumer law (DMCC Act 2024) bans presenting reviews misleadingly,
-- e.g. dropping the bad ones from a score) | pending / declined — reserved for reviews customers
-- send in themselves (requested after a booking or order; the owner approves before they appear).

BEGIN;

CREATE TABLE IF NOT EXISTS org_reviews (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    author_name      TEXT NOT NULL,
    author_detail    TEXT,
    rating           SMALLINT CHECK (rating BETWEEN 1 AND 5),
    body             TEXT NOT NULL,
    source           TEXT NOT NULL DEFAULT 'direct'
                     CHECK (source IN ('google', 'facebook', 'trustpilot', 'tripadvisor', 'checkatrade', 'yell', 'direct', 'website', 'other')),
    source_url       TEXT,
    reviewed_on      DATE,
    status           TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'pending', 'declined')),
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_reviews_org_idx ON org_reviews (organisation_id, status, reviewed_on DESC);

COMMIT;
