-- master-plan-card-fields.sql
-- Makes every visible pricing-card field DB-driven + Super-Admin editable (Master Data → Plans):
--   tier_description  — the eyebrow line ("Tier 2 · Best for Scaling Founders")
--   description       — the italic sub-heading blurb
--   is_most_popular   — the "Most Popular" pill (at most one plan)
--   is_contact_sales  — Enterprise: shown on pricing.html but NOT self-serve purchasable
-- pricing.html and the comparison table render these from get-plans (with the hardcoded HTML kept
-- only as a pre-fetch fallback). Apply manually (no drizzle-kit push).

BEGIN;

ALTER TABLE master_plans ADD COLUMN IF NOT EXISTS tier_description  text;
ALTER TABLE master_plans ADD COLUMN IF NOT EXISTS description       text;
ALTER TABLE master_plans ADD COLUMN IF NOT EXISTS is_most_popular   boolean NOT NULL DEFAULT false;
ALTER TABLE master_plans ADD COLUMN IF NOT EXISTS is_contact_sales  boolean NOT NULL DEFAULT false;

-- Backfill the three purchasable tiers with the copy that was previously hardcoded in pricing.html.
UPDATE master_plans SET
    tier_description = 'Tier 1 · Best for Solo Operators',
    description      = 'Reclaim hours every day. Hand your most draining task to a helper that never takes a day off.',
    is_most_popular  = false
WHERE tier_key = 'saver';

UPDATE master_plans SET
    tier_description = 'Tier 2 · Best for Scaling Founders',
    description      = 'Scale your business with autonomous goal tracking, advanced analytics, and your own mini digital department.',
    is_most_popular  = true
WHERE tier_key = 'buster';

UPDATE master_plans SET
    tier_description = 'Tier 3 · Best for Teams',
    description      = 'A complete digital workforce built for growing businesses and collaborative teams.',
    is_most_popular  = false
WHERE tier_key = 'employee';

-- Enterprise (Tier 4): a non-purchasable master plan so its card is admin-editable like the others.
-- monthly_price_gbp is NOT NULL, so it carries the advertised "from" figure (£1,199); pricing.html
-- keeps rendering the "+/mo" suffix statically and never routes it through self-serve checkout.
INSERT INTO master_plans (tier_key, name, tier_description, description, monthly_price_gbp, is_contact_sales, is_active)
VALUES (
    'enterprise',
    'Custom Enterprise',
    'Tier 4 · Enterprise',
    'Bespoke digital architecture for complex corporate environments.',
    1199.00,
    true,
    true
)
ON CONFLICT (tier_key) DO UPDATE SET
    tier_description = EXCLUDED.tier_description,
    description      = EXCLUDED.description,
    is_contact_sales = true;

COMMIT;
