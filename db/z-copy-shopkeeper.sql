-- db/z-copy-shopkeeper.sql — the Shopkeeper Assistant's catalogue copy (online shop FR#35), so its
-- three blocking "Details" go-live checks pass: tagline, at least 3 key features, "Works with".
-- Copy, NOT status: the row stays Hidden until an admin moves it on in Admin ▸ Assistants, where the
-- go-live checks run (src/utils/assistant-go-live.ts). Never launch it by editing this row.
--
-- Fills only what is still EMPTY, so anything an admin has already typed on Admin ▸ Assistants wins.
-- The description is replaced only while it is still the original text from db/z-shopkeeper.sql,
-- because that text said it works "on its own": today buyers can only buy through Buy buttons on a
-- Be More Swan website (docs/online-shop-review-plan.md §10; the shop page of its own is end of Phase 1).
-- Mirrored in db/z-shopkeeper.sql (fresh databases) and db/seed-catalog.ts.
-- tests/shopkeeper-go-live.test.ts runs the real go-live checks on this copy.
--
-- "z-copy-…" sorts BEFORE z-shopkeeper.sql, so on a fresh database this does nothing and the insert
-- there carries the same copy. Idempotent.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (staging first):
--   npm run db:migrate:apply -- --only z-copy-shopkeeper.sql                              (staging)
--   npm run db:migrate:apply -- --only z-copy-shopkeeper.sql --url-var DATABASE_URL_PROD  (prod)
-- Check afterwards:
--   SELECT tagline, key_features, integrations, works_with, description FROM master_assistants WHERE role_key = 'shopkeeper';

BEGIN;

UPDATE master_assistants SET
    tagline      = COALESCE(NULLIF(btrim(tagline), ''),
                   'Take payments, show buyers what the law asks for, and keep your orders in one place.'),
    key_features = CASE WHEN jsonb_array_length(COALESCE(key_features, '[]'::jsonb)) = 0
                   THEN '["0% Fee on Your Sales","Paid Straight to Your Own Stripe","The Delivery & Returns Details UK Law Asks For","Every Order in One Place"]'::jsonb
                   ELSE key_features END,
    integrations = CASE WHEN jsonb_array_length(COALESCE(integrations, '[]'::jsonb)) = 0
                   THEN '["Stripe"]'::jsonb ELSE integrations END,
    works_with   = CASE WHEN jsonb_array_length(COALESCE(works_with, '[]'::jsonb)) = 0
                   THEN '["website_assistant"]'::jsonb ELSE works_with END,
    description  = CASE WHEN description = 'Runs your online shop with you: connects Stripe so buyers pay you directly (Be More Swan takes no fee), fills in the Delivery & returns details UK law asks for, and keeps your orders in one place. Works with your Be More Swan website or on its own.'
                   THEN 'Runs your online shop with you: connects your own Stripe account so buyers pay you directly (Be More Swan takes no fee on your sales), asks for the Delivery & returns details UK law says buyers must see, and keeps your orders in one place. Buyers buy through Buy buttons on a website made with the Website Assistant.'
                   ELSE description END,
    updated_at   = now()
WHERE role_key = 'shopkeeper';

COMMIT;
