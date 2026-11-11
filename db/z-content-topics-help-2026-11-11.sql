-- db/z-content-topics-help-2026-11-11.sql — Help Centre: Blog and Email topics (docs/pillar-records-plan.md §7,
-- phase 3b). Re-saves "Content Pillars: The Themes Your Posts Rotate Between" with a "Blog and Email: Topics"
-- section, so Ask Your Team (answers ONLY from published help_articles) can explain topics too.
-- Supersedes the body in db/z-content-pillars-help-2026-11-11.sql (same title, upserted).
--
-- Run on the database the app code is on: staging now, prod when the staging→main PR carries it.
-- Idempotent: upserts by title. RETURNs, so the Neon SQL editor shows what it did. No semicolons inside
-- string literals (the Neon editor splits pasted scripts on them). The body is $$-quoted.

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Your Assistants', 40, 'Content Pillars: The Themes Your Posts Rotate Between', $$
# Content Pillars: The Themes Your Posts Rotate Between

Content pillars are the handful of themes your Social Media Assistant posts about, such as "Behind the scenes", "Customer stories" or "Quick tips". Your assistant gives each new post one pillar, and picks the pillars used least lately, so every pillar gets its turn.

## Where to find them

Open your Social Media Assistant, then **Assistant Settings ▸ What I post about ▸ Content Pillars**. Each pillar is its own row.

| On each pillar | What it does |
|----------------|--------------|
| **Name** | A short theme, a few words. Change it and press Enter or click away to save |
| **Description** | Optional. Say what belongs under this pillar, such as "studio process, kiln days, works in progress". Your assistant reads it when it writes a post under that pillar |
| **On / Off** | Up to 5 pillars can be switched on. A switched-off pillar keeps its place but isn't used for new posts |
| **▲ ▼** | Change the order |
| **Archive** | Takes the pillar out of the list. Posts already written under it keep it |

Every change saves straight away.

## Bringing a pillar back

Archived pillars are listed under **Archived pillars** below the list. Press **Bring back** and the pillar returns with its description and its post history. If 5 pillars are already on, it comes back switched off.

## Asking your assistant in chat

You can ask your Social Media Assistant to add, rename, describe, switch off, archive or bring back a pillar, for example "add a pillar called Customer stories about real clients and the time they got back". It shows a card with the change, and nothing changes until you press the card's button. It changes one pillar per card.

## After a change

Your assistant writes posts a few weeks ahead, so a change to your pillars only reaches posts written after it. After you change a pillar, it offers to redraft the upcoming drafts. It shows how many posts, their dates and the tasks it uses before you press **Redraft**. Posts you approved or wrote yourself are never redrafted.

## Seeing the balance

**Results ▸ Posts by pillar** shows how many posts went under each pillar in the last 60 days. A post sent to several platforms counts once. A pillar you renamed keeps its count.

## Blog and Email: Topics

Your Blog Writing Assistant and your Email Marketing Assistant work the same way, but they call them **topics**. Open the assistant, then **Assistant Settings ▸ When and how I work ▸ Topics & themes**. Each topic is its own row with a name, an optional description, On / Off, ▲ ▼ and Archive, and every change saves straight away.

- Up to **8 topics** can be switched on.
- Your **Blog Writing Assistant** gives each new article the topic used least lately. When you've asked for something specific, such as a rewrite with your reason or a campaign article, that comes first.
- Your **Email Marketing Assistant** leads each new email with the topic used least lately, and may mention the others briefly.
- You can ask either assistant in chat to add, rename, describe, switch off, archive or bring back a topic. It shows a card, and nothing changes until you press its button.
- **Results ▸ Posts by topic** (Blog) and **Results ▸ Emails by topic** (Email) show how many went under each topic in the last 90 days.
$$, TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = now()
RETURNING title, is_published;

COMMIT;
