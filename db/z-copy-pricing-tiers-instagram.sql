-- db/z-copy-pricing-tiers-instagram.sql — 2026-10-20 copy pass. Safe to re-run.
--
-- 1. Pricing-card headline + blurb for the two self-serve plans. pricing.html renders these from
--    master_plans (Admin ▸ Master Data ▸ Plans); the copy in pricing.html is only the pre-fetch
--    fallback, so the page keeps the OLD wording until this runs. The "Tier N ·" prefix is stripped
--    by the page (stripTierPrefix) and kept here because other surfaces read the full value.
UPDATE master_plans
   SET tier_description = 'Tier 1 · Best for solo business owners',
       description      = 'One assistant that takes your most time-consuming job off your plate, every day.'
 WHERE tier_key = 'saver';

UPDATE master_plans
   SET tier_description = 'Tier 2 · Best for growing businesses',
       description      = 'Every assistant, working as one team on your social media, blog, email and leads. Includes goal tracking and an editor that checks the work.'
 WHERE tier_key = 'buster';

-- 2. Social Media Assistant "Connects with" chips (Assistant Library card, detail modal, role page).
--    Instagram names the account type, since a personal account cannot connect. TikTok has no
--    connector, so it shows as a muted "Coming soon" chip. Mirrors db/seed-assistant-content.ts.
UPDATE master_assistants
   SET integrations = '["Facebook", "Instagram (Business or Creator)", "LinkedIn", "X (Twitter)", "Threads", "YouTube", "TikTok (coming soon)"]'::jsonb
 WHERE role_key = 'social_media_manager';
