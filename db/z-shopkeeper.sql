-- db/z-shopkeeper.sql — the Shopkeeper Assistant's catalogue row (online shop FR#35,
-- docs/online-shop-review-plan.md §10). Code: netlify/functions/shop.ts, src/components/assistant-shop.js,
-- the `shopkeeper` route in chat-orchestrator.ts. Same row as db/seed-catalog.ts (fresh databases).
-- Copy (tagline, key features, works with) added 2026-11-16; databases that already had the row get it
-- from db/z-copy-shopkeeper.sql.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent; no table changes, so the order
-- against the deploy doesn't matter (the code reads nothing new).
--   npm run db:migrate:apply -- --only z-shopkeeper.sql                              (staging)
--   npm run db:migrate:apply -- --only z-shopkeeper.sql --url-var DATABASE_URL_PROD  (prod)
--
-- HIDDEN (is_active false, lifecycle 'draft'): nobody can hire it until an admin moves it on in
-- Admin ▸ Assistants, where the go-live checks run. Never launch it by editing this row.

BEGIN;

INSERT INTO master_assistants (role_key, name, description, category, icon_key, icon_color, tagline, key_features, integrations, works_with, coming_soon, is_active, lifecycle_state)
VALUES ('shopkeeper', 'Shopkeeper Assistant',
        'Runs your online shop with you: connects your own Stripe account so buyers pay you directly (Be More Swan takes no fee on your sales), asks for the Delivery & returns details UK law says buyers must see, and keeps your orders in one place. Buyers buy through Buy buttons on a website made with the Website Assistant.',
        'Marketing & Sales', 'chart', 'green',
        'Take payments, show buyers what the law asks for, and keep your orders in one place.',
        '["0% Fee on Your Sales","Paid Straight to Your Own Stripe","The Delivery & Returns Details UK Law Asks For","Every Order in One Place"]'::jsonb,
        '["Stripe"]'::jsonb,
        '["website_assistant"]'::jsonb,
        false, false, 'draft')
ON CONFLICT (role_key) DO NOTHING;

COMMIT;
