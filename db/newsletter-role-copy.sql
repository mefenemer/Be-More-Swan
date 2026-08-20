-- db/newsletter-role-copy.sql
-- The Newsletter Assistant's catalogue and detail-page copy, corrected at go-live.
--
-- ⚠️ WHY THIS EXISTS RATHER THAN "just re-run the content seed". `npx tsx db/seed-assistant-content.ts`
-- rewrites tagline / key_features / integrations / works_with / video for ALL 24 roles it carries,
-- unconditionally and with no confirmation — and its own header says so: "re-running restores any
-- admin edit back to these values". Copy is admin-editable in Master Data → Assistants, so on a
-- database where anyone has touched another role's copy, the seed silently reverts that work to
-- whatever the file last said. Only ONE role's copy actually changed here, so only one row is
-- written. (It also targets NETLIFY_DATABASE_URL, which locally points at STAGING — so the seed
-- would not have reached production anyway without repointing the connection string.)
--
-- Kept in step with the newsletter_editor entry in db/seed-assistant-content.ts: if you edit one,
-- edit the other, or the next full seed run will undo this.
--
-- ── What changed and why ────────────────────────────────────────────────────────────────────────
--  • "Curated Industry Round-Ups" → removed. That is a research capability nothing in the pipeline
--    performs; the drafting prompt explicitly forbids inventing facts it was not given, so the card
--    was promising the one thing the assistant is built not to do.
--  • Mailchimp → removed. It is not built and never has been. What exists is sending from a domain
--    the customer verifies, or from their connected Gmail/Outlook for a small list.
--
-- Idempotent. Apply to staging first, then prod, as the DB owner.

UPDATE master_assistants
   SET tagline      = 'A newsletter worth opening — without the weekly scramble.',
       key_features = '["Drafts in Your Brand Voice","Personalised Per Subscriber","Sign-Up Form for Your Website","You Approve Every Issue"]'::jsonb,
       integrations = '["Your own sending domain","Gmail","Outlook"]'::jsonb,
       description  = 'Drafts your newsletter in your brand voice, personalises it for each subscriber, and sends it to the audience you choose — you review and approve every issue before it goes.',
       updated_at   = now()
 WHERE role_key = 'newsletter_editor';

-- Verify:
--   SELECT role_key, coming_soon, tagline, key_features, integrations
--     FROM master_assistants WHERE role_key = 'newsletter_editor';
