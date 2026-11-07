-- db/help-articles-review-links-2026-11-07.sql: Help Centre, guest review links. NEW article.
-- Ask Your Team answers only from published help_articles.
--
-- ⚠️ Run on each database WITH the release that carries the feature, not before.
--
-- Same rules as the other help files: body dollar-quoted, title single-quoted, NO semicolons inside
-- the body. Idempotent.

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published)
SELECT 'Your Assistants', 9, 'Getting Someone''s Thoughts on a Post', $$
# Getting Someone's Thoughts on a Post

You can send a post to a colleague, a manager or a client before it goes out. They don't need an account. They open a private link, read the post, and either approve it or ask for changes.

## Sharing a post

1. Open the post from your **Review** page.
2. Under **Get someone's thoughts**, press **Share for review**.
3. Add who it's for if you like, and an email address if you'd like us to send it.
4. Press **Create link**, then copy the link if you're sharing it yourself.

The link is only shown once, so copy it before you close the post. If you lose it, make another.

You can also ask your Social Media Assistant in chat, for example "send this to Sarah to approve". It shows a card, and the link is only made when you press **Create link**.

## What they can see

Only that one post: its words, pictures, hashtags, link and planned date, for each platform it's going to. They can't see anything else in your workspace, and they can't edit anything.

Anyone who has the link can open it, so share it only with people you'd show the post to.

## What happens when they respond

You get a notification, and the post shows their name and what they said. The name is whatever they typed, so we can't confirm who it was.

**Their response never posts anything.** You still decide what happens next:

- To go ahead, approve the post as usual.
- To act on their comments, press **Use these comments**. That puts them in your **What should I change?** box, ready for you to edit before you press **Regenerate**.

If the post has changed since they responded, you'll see **Changed since this response**.

## How long links last

A link lasts 30 days. Press **Revoke** on the post to stop it working sooner. A link also stops working if the post is rejected or removed, the assistant is archived, or your plan or trial ends.

Sharing is free on every plan and trial, and uses no tasks. Their name and comments are kept in your workspace and included in your data export.
$$, TRUE
WHERE NOT EXISTS (SELECT 1 FROM help_articles WHERE title = 'Getting Someone''s Thoughts on a Post')
RETURNING title, 'added' AS result;

COMMIT;
