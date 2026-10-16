-- db/z-product-dietary.sql — dietary markers on Business Information products (for menus).
-- Code: src/utils/product-dietary.ts, org-products.ts, site-render.ts (menu section), assets.html.
-- Drizzle mirror: db/schema.ts (orgProducts.dietary, .allergens).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-product-dietary.sql                              (staging)
--   npm run db:migrate:apply -- --only z-product-dietary.sql --url-var DATABASE_URL_PROD  (prod)
--
-- dietary:   a closed set of markers — ["vegetarian","vegan","gluten_free","dairy_free","contains_nuts","spicy"]
--            (product-dietary.ts DIETARY). Shown on a menu as V · VG · GF · DF · N · 🌶 with a key.
-- allergens: the owner's own words ("Contains: milk, egg, sesame"), shown under the item. Optional.
-- What the menu shows is the owner's statement; the site adds "Ask us about allergens" so nobody
-- relies on the website alone (UK food businesses must give allergen information on request).

ALTER TABLE org_products ADD COLUMN IF NOT EXISTS dietary   JSONB;
ALTER TABLE org_products ADD COLUMN IF NOT EXISTS allergens TEXT;
