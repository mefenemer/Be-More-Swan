-- db/help-articles-2026-12zzzzzzzzzzzzz-discussions.sql — Help Centre: the Lead Generator's
-- Discussions tab (2026-10-30).
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzzzz-follow-up-preview.sql. One new article in
-- 'Lead Management', after 'Exporting Leads and Recording Outcomes' (40).
--
-- Written from the code:
--   form labels, banner, empty states, button names     — src/components/assistant-discussions.js
--   the four sites + their rules notes                   — src/config/discussion-sites.ts DISCUSSION_SITES
--   own forums (up to 5, by address) + suggestions      — discussion-sites.ts MAX_OWN_FORUMS, SUGGESTED_FORUMS
--   up to 5 topics, last 7 days, relevance 50+           — discussion-sites.ts MAX_TOPICS, MAX_THREAD_AGE_DAYS, MIN_RELEVANCE
--   disclosure line added in code, warning if removed    — withDisclosure / hasDisclosure
--   page read only where robots.txt allows (else summary) — src/utils/discussions.ts readThread
--   one scan = one task, daily scan ~7am when ticked     — runScan recordCompletedWork, netlify.toml 50 6 * * *
--   chat cards (topics, scan, redraft, mark, dismiss)    — src/utils/chat-discussion-action.ts
--
-- ⚠️ Apply on PROD only after the staging→main release that ships the tab — Ask Your Team answers from
-- published articles, so publishing early would describe a tab customers can't see yet.
--
-- Same rules as the other help files: body dollar-quoted, title single-quoted with '' for an
-- apostrophe, NO semicolons inside the body. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzzzz-discussions --execute --yes

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Lead Management', 50, 'Finding Forum Threads Worth Replying To', $$
# Finding Forum Threads Worth Replying To

Every day, people ask for recommendations on public forums: "can anyone recommend a bookkeeper for a small café?" Your Lead Generator's **Discussions** tab finds those threads and drafts a helpful reply for each one. You read it, change it if you want, and post it yourself.

## You post, not us

Be More Swan never posts anything on these sites. You copy the reply, open the thread and post it from your own account.

Every reply ends with a line like *(Full disclosure: I work at Your Business, so I'm biased.)*. Please keep it in. The forums' own rules and UK consumer law both expect you to say when you're recommending your own business. If you delete it while editing, the card warns you.

## Setting it up

Open your Lead Generator and go to **Discussions**. Under **What to watch**:

- **Topics**: up to 5, one per line. Write each one the way a customer would ask for help, not your business name. "Best wedding photographer in Bristol" works far better than "Smith Photography".
- **Sites**: Reddit, UK Business Forums, Quora and LinkedIn posts. The first three are ticked to start with.
- **Your own forums**: add up to 5 more by web address, such as a trade forum or a US community. There are a few one-click suggestions, including Indie Hackers and Shopify Community.
- **Scan every morning**: leave it ticked and your assistant looks for new threads each morning.

Press **Save**, or press **Scan now** to look straight away. New threads appear in a minute or two.

You can also ask your Lead Generator in chat, for example "watch Reddit for people asking for a florist in Leeds". It shows a card with the topics, and nothing changes until you press its button.

## What it finds

Each scan looks at threads from the last week and keeps only the ones where your business could genuinely help. Most threads that mention a keyword aren't a real fit, so it's normal for a scan to keep only a few, or none at all.

Each card shows:

- the thread's title, site and when it was posted
- why it's worth replying to, and whether the person is asking for what you sell or asking for advice you can give
- the drafted reply, which you can edit in the box. Press **Save my changes** to keep your edits.
- a short note about that site's rules on mentioning your business

Some sites, such as Reddit and Quora, don't let us read the thread page itself. Then the reply is drafted from the search result's short summary, and the card says so. Read the whole thread before you post.

## Replying

1. Press **Copy reply & open thread**. The reply is copied and the thread opens in a new tab.
2. Paste the reply, check it reads right, and post it.
3. Come back and press **Mark replied**.

Want a different reply? Press **Redraft** and say what should change, or leave it blank to just improve it. Not worth replying to? Press **Dismiss**. Threads you've replied to or dismissed are kept under **Replied** and **Dismissed**, and **Put back in New** brings one back.

Your Lead Generator can do these from chat too. Ask it to redraft a reply, mark one as replied or dismiss one, then press the button on its card.

## Good to know

- One scan costs one task, whether you press Scan now or it runs in the morning. Redrafting a reply doesn't use a task.
- The same thread is never shown twice.
- Read the community's rules before you reply. Many subreddits ban self-promotion or only allow a little. The most useful answer, with your business mentioned once, works best everywhere.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  updated_at = now()
RETURNING title, is_published, length(content_md);

-- Check (expect 1 row, published):
--   SELECT title, is_published, length(content_md) FROM help_articles WHERE title = 'Finding Forum Threads Worth Replying To';
