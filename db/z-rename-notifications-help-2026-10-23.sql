-- db/z-rename-notifications-help-2026-10-23.sql — Help Centre, owner decision 2026-10-23.
--
-- "Inbox", the header bell and "Team Chat" became ONE side-menu item, **Notifications**, with three
-- tabs: Needs you, Messages (Team Chat) and Updates (commit db6d9324). "Inbox" is kept free for the
-- person's own email later. Two published articles still named the old item:
--   • "Your Dashboard Overview" — its sidebar table had an **Inbox** row (and, if an edit made only in
--     the live DB added one, a **Team Chat** row — removed by pattern below).
--   • "Common Issues: Symptoms, Causes & Fixes" — sent people to "workspace settings in **Inbox**",
--     a place that never held settings. Preferences are under My Account ▸ Notification Preferences.
-- Plus one new article describing the page, so Ask Your Team (answers ONLY from published
-- help_articles) can explain the tabs and the count.
--
-- Idempotent: REPLACE on exact strings is a no-op once applied, the new article upserts by title.
-- Each statement RETURNs, so the Neon SQL editor shows what it changed. No semicolons inside string
-- literals (the Neon editor splits pasted scripts on them). Bodies are $$-quoted: write apostrophes
-- once there, but DOUBLE them in the single-quoted REPLACE strings and titles.

BEGIN;

UPDATE help_articles
   SET content_md = regexp_replace(
         REPLACE(content_md,
           '| **Inbox** | Notifications from your assistants, and your alert preferences |',
           '| **Notifications** | What needs you, your assistants'' messages (Team Chat) and updates. The bell at the top shows the same count |'),
         '\n\| \*\*Team Chat\*\* \|[^\n]*', '', 'g'),
       updated_at = now()
 WHERE title = 'Your Dashboard Overview'
   AND (content_md LIKE '%| **Inbox** |%' OR content_md LIKE '%| **Team Chat** |%')
RETURNING title, 'sidebar table updated' AS result;

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         '**Assistant Profile ▸ Notifications**, or your workspace settings in **Inbox**',
         '**Assistant Profile ▸ Notifications**, or **My Account ▸ Notification Preferences** for your whole workspace'),
       updated_at = now()
 WHERE title = 'Common Issues: Symptoms, Causes & Fixes'
   AND content_md LIKE '%your workspace settings in **Inbox**%'
RETURNING title, 'alerts row updated' AS result;

-- 'Getting Started' is reused on purpose: help-content.html hardcodes the category chips, so a new
-- category would only be reachable through "All Articles".
INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Getting Started', 21, 'Notifications: What Needs You, Messages and Updates', $$
# Notifications: What Needs You, Messages and Updates

Everything your assistants want you to know is in one place: **Notifications** in the side menu. The bell at the top of every page shows the same count and opens a quick view.

## The three tabs

| Tab | What's there | How it clears |
|-----|--------------|---------------|
| **Needs you** | Things only you can do, such as a draft to review, a connection to reconnect or a payment to fix, and questions your assistants have asked you | Doing the thing, or answering the question. Reading it does not clear it |
| **Messages** | Team Chat. Your assistants say what they are doing, and you can write to any of them. They reply here | Reading them under **Everything** or **Me** |
| **Updates** | Things that have happened, such as a post published or an invoice ready | Reading them, or **Mark all as read** |

## The count

- A **red number** is how many things need you.
- A **grey dot** means nothing needs you, but there is something new to read.

## Answering a question

Press one of the answers on the question. Your assistant's reply appears straight away. For anything a button can't say, press **Open conversation** to write to them in Messages.

## Finding something

Use **From** to see one assistant, or Be More Swan's own notices, and **Group by** to sort by type, assistant or day. **Combine platforms** shows a post that went to several platforms once rather than once per platform.

## Choosing what you're told about

Choose which notifications you get under **My Account ▸ Notification Preferences**, or for one assistant under **Assistant Profile ▸ Notifications**.
$$, TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = now()
RETURNING title, is_published;

COMMIT;

-- Anything PUBLISHED that still names the old menu items — expected: no rows.
SELECT title FROM help_articles
 WHERE is_published
   AND (content_md LIKE '%| **Inbox** |%' OR content_md LIKE '%settings in **Inbox**%' OR content_md LIKE '%| **Team Chat** |%');
