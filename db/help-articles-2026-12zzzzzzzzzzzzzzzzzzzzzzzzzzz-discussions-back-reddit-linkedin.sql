-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzz-discussions-back-reddit-linkedin.sql — Help Centre:
-- the Lead Generator's Discussions tab is BACK (owner, 2026-11-11), Reddit and LinkedIn only. It had been
-- paused 2026-11-10 (…-discussions-paused.sql unpublished the article and took the Mentor line out).
--
-- Rewrites 'Finding Forum Threads Worth Replying To' for two sites (UK Business Forums, Quora and
-- "Your own forums" are gone — src/config/discussion-sites.ts DISCUSSION_SITE_KEYS, MAX_OWN_FORUMS = 0),
-- publishes it again, and puts the Mentor article's forum-watching line back.
--
-- ⚠️ Apply on PROD only after the staging→main release that brings the tab back — Ask Your Team answers
-- from published articles. Safe to run twice. Staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzz-discussions-back-reddit-linkedin --execute --yes

UPDATE help_articles
   SET content_md = $$
# Finding Forum Threads Worth Replying To

Every day, people ask for recommendations on Reddit and LinkedIn: "can anyone recommend a bookkeeper for a small café?" Your Lead Generator's **Discussions** tab finds those threads and posts and drafts a helpful reply or comment for each one. You read it, change it if you want, and post it yourself.

## You post, not us

Be More Swan never posts anything on Reddit or LinkedIn. You copy the reply, open the thread or post and post it from your own account.

Every reply ends with a line like *(Full disclosure: I work at Your Business, so I'm biased.)*. Please keep it in. Reddit's community rules and UK consumer law both expect you to say when you're recommending your own business. If you delete it while editing, the card warns you.

## Setting it up

Open your Lead Generator and go to **Discussions**. Under **What to watch**:

- **Topics**: up to 5, one per line. Write each one the way a customer would ask for help, not your business name. "Best wedding photographer in Bristol" works far better than "Smith Photography".
- **Sites**: Reddit and LinkedIn posts. Both are ticked to start with. Untick one if it isn't where your customers are.
- **Scan every morning**: leave it ticked and your assistant looks for new threads and posts each morning.

Press **Save**, or press **Scan now** to look straight away. New threads appear in a minute or two.

You can also ask your Lead Generator in chat, for example "watch LinkedIn for people asking for a bookkeeper". It shows a card with the topics, and nothing changes until you press its button.

## What it finds

Each scan looks at threads and posts from the last week and keeps only the ones where your business could genuinely help. Most that mention a keyword aren't a real fit, so it's normal for a scan to keep only a few, or none at all.

Each card shows:

- the title, the site and when it was posted
- why it's worth replying to, and whether the person is asking for what you sell or asking for advice you can give
- the drafted reply, written from what's already been said wherever the page can be read, which you can edit in the box. Press **Save my changes** to keep your edits.
- a short note about that site's rules on mentioning your business

Some pages, such as Reddit threads, can't be read in full. Then the reply is drafted from the search result's short summary, and the card says so. Read the whole thread before you post.

## Replying

1. Press **Copy reply & open thread**. The reply is copied and the thread or post opens in a new tab.
2. Paste the reply, check it reads right, and post it.
3. Come back and press **Mark replied**.

Want a different reply? Press **Redraft** and say what should change, or leave it blank to just improve it. Not worth replying to? Press **Dismiss**. Threads you've replied to or dismissed are kept under **Replied** and **Dismissed**, and **Put back in New** brings one back.

Your Lead Generator can do these from chat too. Ask it to redraft a reply, mark one as replied or dismiss one, then press the button on its card.

## Good to know

- Discussions watches Reddit and LinkedIn only. Want another site? Ask your Lead Generator in chat and it can send the request to the Be More Swan team.
- One scan costs one task, whether you press Scan now or it runs in the morning. Redrafting a reply doesn't use a task.
- The same thread is never shown twice.
- On Reddit, read the subreddit's rules before you reply. Many ban self-promotion or only allow a little. On LinkedIn, a short, useful comment works better than a pitch.
$$,
       is_published = true,
       updated_at = now()
 WHERE title = 'Finding Forum Threads Worth Replying To'
RETURNING title, is_published, length(content_md);

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         '- **Your plan** and the tasks used this month',
         '- **Your Lead Generator''s forum watching:** what it watches on Reddit and LinkedIn and how many threads are waiting (never the threads or replies themselves)
- **Your plan** and the tasks used this month'),
       updated_at = now()
 WHERE title = 'Meet Your Business Mentor'
   AND content_md NOT LIKE '%forum watching%'
RETURNING title, length(content_md);

-- Check (expect true, true, false):
--   SELECT bool_or(is_published) FILTER (WHERE title = 'Finding Forum Threads Worth Replying To'),
--          bool_or(content_md LIKE '%forum watching%') FILTER (WHERE title = 'Meet Your Business Mentor'),
--          bool_or(content_md LIKE '%Quora%') FILTER (WHERE title = 'Finding Forum Threads Worth Replying To')
--     FROM help_articles;
