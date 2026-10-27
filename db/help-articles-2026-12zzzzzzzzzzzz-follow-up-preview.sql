-- db/help-articles-2026-12zzzzzzzzzzzz-follow-up-preview.sql — Help Centre: previewing a follow-up
-- (2026-10-27). docs/lead-outreach-restructure-plan.md, Phase 4.
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzzz-follow-up-plan.sql, which wrote the sentence this
-- appends to — so the anchor text is known exactly. One addition to 'Sending Outreach and Handling
-- Replies', at the end of its "Your follow-up plan" section.
--
-- Written from the code:
--   Preview this one (panel, unsaved wording, a chosen lead) — src/components/assistant-follow-up-plan.js
--   Preview the next one (a conversation under Following up)  — src/components/assistant-lead-threads.js
--   the chat's follow_up_preview card                           — src/utils/chat-follow-up-plan.ts
--   same drafter as the real send, nothing sent or stored       — process-sequence-sends.ts previewFollowUp
--   only leads emailed from the app, still being followed up    — lead-generation.ts preview_follow_up
--
-- Same rules as the other help files: single-quoted literals with '' for an apostrophe, NO semicolons
-- inside any literal. Idempotent: guarded by NOT LIKE on the new heading. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzzz-follow-up-preview --execute --yes

UPDATE help_articles
   SET content_md = replace(content_md,
           'nothing changes until you press **Save this plan**.',
           'nothing changes until you press **Save this plan**.

### Preview a follow-up

Want to see what a follow-up would actually say? Two ways, and **nothing is sent** either way:

- In **Follow-up plan**, pick a lead under **Preview with**, then press **Preview this one** under any follow-up. It uses the wording on screen, so you can try a change before saving it.
- Open a lead under **Following up** and press **Preview the next one**.

You can also ask your assistant — "what would the next follow-up to Acme say?" — and press **Write the preview** on its card.

A preview is written exactly the way the real one is, from the conversation so far. The real follow-up is written fresh when it is due, so it can differ a little. Previews only work for leads you emailed from here who haven''t replied yet.'),
       updated_at = now()
 WHERE title = 'Sending Outreach and Handling Replies'
   AND content_md LIKE '%nothing changes until you press **Save this plan**.%'
   AND content_md NOT LIKE '%### Preview a follow-up%'
RETURNING title, is_published;

-- Check (expect 1 row, published, true):
--   SELECT title, is_published, position('Preview a follow-up' in content_md) > 0 AS new_copy
--     FROM help_articles WHERE title = 'Sending Outreach and Handling Replies';
