-- db/z-copy-lead-features.sql — Lead Generation Assistant key features: drop a claim that is not true (2026-10-12).
--
-- "Handoff to CRM Enricher for missing data" named a hand-off to the CRM Data Assistant, which is Coming
-- soon and is called by nothing — the line promised a feature no customer can use. Replaced with the one
-- thing the role guarantees on every send. The other two features stand. Mirrored in
-- db/seed-assistant-content.ts. These are the ticked bullets on the website library card (assistants.html
-- now reads key_features, first three) and on the assistant page.
-- Apply (staging first): node scripts/db-migrate.mjs apply --only z-copy-lead-features --execute --yes

UPDATE master_assistants
   SET key_features = '["Automated Lead Scoring","Personalised Outreach Drafting","You Approve Every Send"]'::jsonb,
       updated_at = now()
 WHERE role_key = 'lead_qualifier'
   AND key_features ? 'Handoff to CRM Enricher for missing data';
