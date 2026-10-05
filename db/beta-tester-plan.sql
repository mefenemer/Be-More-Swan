-- db/beta-tester-plan.sql
-- The free 'beta' plan for beta testers (decided 2026-10-05; see src/utils/beta-testers.ts).
--
-- A copy of the TOP self-serve tier ('employee') — same limits, same features — at £0, with no
-- Stripe product. is_active = false keeps it off the pricing page and the in-app plan picker
-- (get-plans reads is_active = true only); limits are still enforced, because enforcement joins
-- plans.master_plan_id → master_plans regardless of is_active.
--
-- Copied ONCE, at apply time. Later edits to 'employee' do not flow through — edit 'beta' in
-- Admin ▸ Master Data ▸ Plans if testers need different limits.
--
-- Manual-apply migration (idempotent: ON CONFLICT DO NOTHING). Apply to staging + prod BEFORE
-- turning on the beta form, or beta sign-ups create an account with no plan.

INSERT INTO master_plans (
    tier_key, name, tier_description, description, is_most_popular, is_contact_sales,
    monthly_price_gbp, assistant_limit, monthly_task_limit, monthly_token_limit,
    app_connection_limit, seat_limit, storage_limit_bytes, stripe_product_id, features, is_active
)
SELECT
    'beta', 'Beta', 'Beta tester', 'Free full access while Be More Swan is in beta.', false, false,
    0, assistant_limit, monthly_task_limit, monthly_token_limit,
    app_connection_limit, seat_limit, storage_limit_bytes, NULL, features, false
FROM master_plans
WHERE tier_key = 'employee'
ON CONFLICT (tier_key) DO NOTHING;
