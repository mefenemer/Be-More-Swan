-- Migration: deactivate the legacy "Free Trial" master plan
-- The 14-day free trial was removed as a product (see chore/remove-free-trial):
-- register.ts no longer creates trial plans and seed-catalog.ts no longer seeds
-- the trial master plan. But databases seeded before this change still carry the
-- master_plans row (tier_key='trial', "Free Trial"). get-plans.ts already filters
-- it out of the purchasable picker, so this is belt-and-braces: flip it inactive so
-- no code path that lists active master plans can surface it.
--
-- We deactivate rather than DELETE: plan_prices and any historical `plans` rows may
-- FK-reference it, and an inactive catalog row is harmless. Idempotent (only flips
-- true->false; a re-run is a no-op).
--
-- Run: npm run db:migrate:apply   (tracked in schema_migrations)

UPDATE master_plans
SET    is_active = false
WHERE  tier_key = 'trial'
  AND  is_active = true;
