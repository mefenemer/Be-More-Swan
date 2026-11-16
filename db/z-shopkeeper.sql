-- db/z-shopkeeper.sql — the Shopkeeper Assistant's catalogue row (online shop FR#35,
-- docs/online-shop-review-plan.md §10). Code: netlify/functions/shop.ts, src/components/assistant-shop.js,
-- the `shopkeeper` route in chat-orchestrator.ts. Same row as db/seed-catalog.ts (fresh databases).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent; no table changes, so the order
-- against the deploy doesn't matter (the code reads nothing new).
--   npm run db:migrate:apply -- --only z-shopkeeper.sql                              (staging)
--   npm run db:migrate:apply -- --only z-shopkeeper.sql --url-var DATABASE_URL_PROD  (prod)
--
-- HIDDEN (is_active false, lifecycle 'draft'): nobody can hire it until an admin moves it on in
-- Admin ▸ Assistants, where the go-live checks run. Never launch it by editing this row.

BEGIN;

INSERT INTO master_assistants (role_key, name, description, category, icon_key, icon_color, coming_soon, is_active, lifecycle_state)
VALUES ('shopkeeper', 'Shopkeeper Assistant',
        'Runs your online shop with you: connects Stripe so buyers pay you directly (Be More Swan takes no fee), fills in the Delivery & returns details UK law asks for, and keeps your orders in one place. Works with your Be More Swan website or on its own.',
        'Marketing & Sales', 'chart', 'green', false, false, 'draft')
ON CONFLICT (role_key) DO NOTHING;

COMMIT;
