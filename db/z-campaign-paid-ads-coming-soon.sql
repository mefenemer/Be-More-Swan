-- db/z-campaign-paid-ads-coming-soon.sql — announce the Marketing Campaign Orchestrator's planned
-- paid-advertising connections on its catalogue card, marked as not yet available.
--
-- Entries ending "(coming soon)" render as a muted "Coming soon" chip, not a connectable tool
-- (AssistantContent.integrationChip, src/public/assistant-content.js). Nothing is connectable: no
-- Meta Ads, Google Ads or LinkedIn Ads connector exists, and the campaign chat still says paid
-- advertising is not available. Edit or remove later on Admin ▸ Assistants → Details → Integrations.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent and safe to re-run: it only
-- fills the list when it is EMPTY, so an admin edit made since is never overwritten.
--   npm run db:migrate:apply -- --only z-campaign-paid-ads-coming-soon                              (staging)
--   npm run db:migrate:apply -- --only z-campaign-paid-ads-coming-soon --url-var DATABASE_URL_PROD  (prod)
-- Order does not matter: the code renders these chips correctly before or after it runs.

UPDATE master_assistants
   SET integrations = '["Meta Ads (coming soon)", "Google Ads (coming soon)", "LinkedIn Ads (coming soon)"]'::jsonb,
       updated_at   = now()
 WHERE role_key = 'campaign_orchestrator'
   AND (integrations IS NULL OR integrations = '[]'::jsonb);
