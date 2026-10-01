-- db/email-marketing-copy.sql
-- The Email Marketing Assistant's catalogue and detail-page copy (2026-10-01), written by the user
-- for the role's wider job: one-off emails AND email campaigns, plus the sign-up form / hosted page.
-- Same shape and same reason as db/newsletter-role-copy.sql: ONE row is written, rather than
-- re-running db/seed-assistant-content.ts, which rewrites every role's admin-editable copy.
--
-- Kept in step with the newsletter_editor entries in db/seed-assistant-content.ts (tagline, key
-- features, integrations) and db/seed-catalog.ts (description). Edit one, edit the others.
--
-- Idempotent. Apply to staging first, then prod.

UPDATE master_assistants
   SET tagline      = 'Newsletters and email campaigns worth opening — without the weekly scramble.',
       description  = 'Writes your regular emails and short email campaigns — from a welcome series for new subscribers to renewal reminders and win-backs — in your brand voice, personalised for each subscriber. A sign-up form for your website, or a shareable sign-up page if you don''t have one, grows your list. You review and approve every email before it sends.',
       key_features = '["Automated Campaigns & Sequences: Easily set up structured email flows for client onboarding, product purchases, or subscription renewals.", "Drafts in Your Brand Voice: Understands your style to ensure every broadcast and automated email sounds exactly like you.", "Sign-Up Form or Shareable Page", "You Approve Every Email"]'::jsonb,
       integrations = '["Your own sending domain", "Gmail", "Outlook", "Any website, via embed code"]'::jsonb,
       updated_at   = now()
 WHERE role_key = 'newsletter_editor';

-- Verify:
--   SELECT tagline, description, key_features, integrations FROM master_assistants WHERE role_key = 'newsletter_editor';
