-- db/help-articles-2026-12zzzzzzzzzzz-follow-up-plan.sql — Help Centre: the follow-up plan is editable
-- (2026-10-27). docs/lead-outreach-restructure-plan.md, Phase 3.
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzz-outreach-stages.sql, which wrote the paragraph this
-- replaces — so the old text is known exactly. One swap in 'Sending Outreach and Handling Replies':
-- the fixed "3 days, then a week" cadence becomes the editable Follow-up plan.
--
-- Written from the code:
--   the panel                  — src/components/assistant-follow-up-plan.js (Outreach ▸ Follow-up plan)
--   limits (1–5, 1–30 days)    — src/config/follow-up-plan.ts FOLLOW_UP_LIMITS
--   the last one says so       — LAST_FOLLOW_UP_RULE, added by process-sequence-sends.ts
--   switching off              — lead-generation.ts save_follow_up_plan (stopRunning is a choice)
--   from chat                  — the follow_up_plan card (src/utils/chat-follow-up-plan.ts)
--
-- Same rules as the other help files: single-quoted literals with '' for an apostrophe, NO semicolons
-- inside any literal. Idempotent: guarded by LIKE on the old paragraph. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzz-follow-up-plan --execute --yes

UPDATE help_articles
   SET content_md = replace(content_md,
           'If your assistant is set to chase, approving also starts its follow-up plan: **up to three more emails** — after 3 days, then a week, then a short sign-off — each written in the context of the conversation. Each lead shows which follow-up is next and when. They stop the moment the prospect replies, and the last one always says it is the last. Turn the whole thing off with **Chase leads who do not reply?** in the assistant''s operational setup.',
           'If your assistant is set to chase, approving also starts its **follow-up plan** — three more emails to start with: after 3 days, then a week, then a short sign-off. Each is written in the context of the conversation, and each lead shows which follow-up is next and when. They stop the moment the prospect replies, and the last one always says it is the last.

## Your follow-up plan

Press **Follow-up plan** on the Outreach tab to see and change it:

- **Chase leads who don''t reply** — switch it off and approving sends one email only. You choose whether leads already being followed up stop too.
- **How many** — one to five follow-ups.
- **How long each waits** — 1 to 30 days after the email before it.
- **What each says** — a sentence or two about what that email should do. Your assistant writes the email itself, in the context of the conversation.

New wording applies to every follow-up not yet sent. A new wait applies from each lead''s next follow-up to be booked. You can also ask your assistant in chat — it shows you a card to confirm, and nothing changes until you press **Save this plan**.'),
       updated_at = now()
 WHERE title = 'Sending Outreach and Handling Replies'
   AND content_md LIKE '%after 3 days, then a week, then a short sign-off — each written in the context%'
RETURNING title, is_published;

-- Check (expect 1 row, published, true):
--   SELECT title, is_published, position('Your follow-up plan' in content_md) > 0 AS new_copy
--     FROM help_articles WHERE title = 'Sending Outreach and Handling Replies';
