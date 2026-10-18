-- db/z-bespoke-assistant-plan.sql
-- Owner decision 2026-10-17: Tier 3 (tier_key 'enterprise', contact-sales) is a BUILD, not a bigger
-- plan — "We build your bespoke assistant", no price on the page, terms agreed after an enquiry.
-- pricing.html renders name / tier line / description from this row (get-plans → enterprisePlan).
-- The tier_key stays 'enterprise': Stripe, admin tools and capture-lead all key off it.
-- Idempotent.

UPDATE master_plans
   SET name             = 'Bespoke Assistant',
       tier_description = 'Tier 3 · We build your bespoke assistant',
       description      = 'Need something our library doesn''t do? We design, build and run an assistant around your business — your workflows, your systems, your volume. Get in touch and we''ll agree the scope and terms with you.'
 WHERE tier_key = 'enterprise';
