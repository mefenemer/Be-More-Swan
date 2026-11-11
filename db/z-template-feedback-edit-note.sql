-- db/z-template-feedback-edit-note.sql (2026-11-11)
-- Fix pipeline #37: after editing an outreach email, "Something else" gave no way to say what the
-- reason was. The reviewer's own words go here. edit_reason stays the CLOSED grouping key; this is
-- free text for people to read and is never clustered (src/config/template-feedback.ts).
--
-- Apply to BOTH databases (staging and prod). Order is forgiving: src/utils/template-feedback.ts
-- only writes the column when a note was typed, so every other edit reason keeps saving if code
-- lands first — but a typed note would fail to save until this has run.
--
--   npm run db:migrate:apply -- --only z-template-feedback-edit-note --yes
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only z-template-feedback-edit-note --url-var PROD_DATABASE_URL --yes

ALTER TABLE template_feedback ADD COLUMN IF NOT EXISTS edit_note text;
