-- db/z-quality-reviewer-copy-2026-10-27.sql — "the In-House Editor" / "an editor that checks the work"
-- renamed to what the product calls it: The Quality Reviewer (owner, 2026-10-27).
--
--   • The Busywork Buster card description (master_plans.description) said "an editor that checks the
--     work". It is the `quality_reviewer` plan feature, a second check on every SOCIAL post (blog and
--     email drafts do not get it — process-content-jobs.ts is the only automatic caller), so the card
--     names it and the feature row below the card says what it checks.
--   • Be More Swan's own Busywork Buster in Products & Services listed "The In-House Editor" as a
--     benefit; the drafting assistants and the Mystery Shopper read that row. Only our own plan rows
--     (url on bemoreswan.com, as plan-products.ts isPlanProduct matches them) are touched.
--
-- Run on staging and prod (Neon SQL editor). Safe to re-run. Every statement RETURNs what it changed.

BEGIN;

UPDATE master_plans
   SET description = 'Every assistant, working as one team on your social media, blog, email and leads. Includes goal tracking and The Quality Reviewer.'
 WHERE tier_key = 'buster'
   AND (description ILIKE '%an editor that checks the work%' OR description ILIKE '%in-house editor%')
RETURNING tier_key, description;

UPDATE org_products
   SET benefits = regexp_replace(benefits, '^[ \t]*the in-house editor[ \t]*$', 'The Quality Reviewer checks every social post before it reaches you', 'gin'),
       updated_at = now()
 WHERE name = 'The Busywork Buster'
   AND url ILIKE '%bemoreswan.com%'
   AND benefits ~* 'in-house editor'
RETURNING id, organisation_id, benefits;

COMMIT;
