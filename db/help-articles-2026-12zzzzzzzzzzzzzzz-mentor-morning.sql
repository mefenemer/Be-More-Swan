-- db/help-articles-2026-12zzzzzzzzzzzzzzz-mentor-morning.sql — Help Centre: the Business Mentor's morning
-- summary (docs/morning-summary-plan.md, src/utils/mentor-morning.ts), 2026-11-02.
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzzzzzz-*.sql. Adds a "The morning summary" section to
-- 'Your Weekly Review and Commitments', before "## Commitments". Wording matches the set-up question
-- (src/public/assistant-onboarding-schemas.js `morningSummary`) and the notification row
-- ("Business Mentor morning summary", email off by default).
--
-- REPLACE on an exact string, guarded: a no-op once applied, safe to re-run. Apply on PROD only after
-- the staging→main release that ships it. Staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzzzzzz-mentor-morning --execute --yes

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         '## Commitments',
         '## The morning summary

At 7am in your business''s time zone, your Business Mentor posts a short summary in each owner''s and admin''s chat with it:

- **Yesterday:** sales and booking deposits taken on your website, and deals marked won in your Lead Generator
- **Today:** your bookings, and booking requests waiting for your yes
- **Enquiries** from your website that haven''t been answered
- **Waiting for you:** posts to review, actions waiting for approval and your Mentor''s suggestions
- **Make next:** your best post of the last two weeks, and which assistant can make another like it

It only reports what Be More Swan can see: things booked, bought or marked won. It can''t see phone calls or sales made elsewhere. On a day with nothing to say, nothing is sent. It''s put together from your figures without AI, so it **uses no tasks**.

You''re told in the app. To get it by email too, switch on **Business Mentor morning summary** in **My Account ▸ Notifications**. If you get it by email, you won''t also get the separate "actions waiting" email that morning.

Switch it off on your Mentor''s profile, under **When and how I work**, or ask your Mentor. There''s no morning summary in Quiet mode or without a paid plan.

## Commitments'),
       updated_at = now()
 WHERE title = 'Your Weekly Review and Commitments'
   AND content_md NOT LIKE '%## The morning summary%'
RETURNING title, length(content_md);

-- Check (expect 1 row, true):
--   SELECT title, content_md LIKE '%## The morning summary%' FROM help_articles WHERE title = 'Your Weekly Review and Commitments';
