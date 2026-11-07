-- db/help-articles-website-placeholder-media-2026-11-06.sql — Help Centre: placeholder pictures and
-- videos on a new website. NEW article. Ask Your Team answers only from published help_articles.
--
-- ⚠️ Run on each database WITH the release that carries the choice, not before.
-- Costs are left out on purpose: the card shows them from the live weights, and AI video's price may
-- change when per-second pricing starts.
--
-- Same rules as the other help files: body dollar-quoted, title single-quoted, NO semicolons inside
-- the body. Idempotent.

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Getting Started', 41, 'Placeholder Pictures and Videos on a New Website', $$
# Placeholder Pictures and Videos on a New Website

When your Website Assistant writes a new site for you, it can also put pictures and videos in its sections, so you see how the site will really look. They stay there until you swap them for your own.

## Choosing what you get

You choose separately for pictures and for videos:

| Choice | What you get | Cost |
|--------|--------------|------|
| **Stock** | Free-to-use photos and clips that suit each section | Free |
| **AI-made** | Pictures or a short clip made for your site | Uses tasks. The cost is shown beside the choice, before anything is made |
| **None** | No pictures or videos | Free |

You can choose in three places: your assistant's set-up questions, the last step of **Set up** on the **Website** tab, and in chat, where your assistant asks and shows the same choice on its card.

AI-made video depends on your plan. If your plan doesn't include it, the choice says so.

## What happens

Your assistant writes the words first and saves them. Then it adds the pictures and videos, which can take a few more minutes, and more if you chose an AI video. You can leave the page while it works.

Everything it adds goes into your **library**. To change one, open that section and use **Choose picture**.

If a picture or video can't be found or made, your site is still written. You're told what's missing, and you aren't charged for it. You're only charged for AI pictures and videos that were actually made.

## Sites from a template or your old website

- **Started from a template:** the template's pictures stay unless you choose stock or AI-made. Only its sample pictures are swapped, and nothing is added to the layout.
- **Brought over from your current website:** your site keeps its own pictures. It never gets placeholders.
- **Your own pictures** already on a section are never replaced.

Nothing goes live until you press **Publish**.
$$)

ON CONFLICT (title) DO NOTHING
RETURNING id, title;

COMMIT;
