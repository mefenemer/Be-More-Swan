-- db/z-assistant-settings-card-names-help-2026-11-14.sql — Help Centre: "Assistant Settings" used the
-- Operating File's OLD card names ("Mandate", "Operational Setup", "Creative Brief", "Rules", "Brand
-- Safety and Legal"). The page says "What I do", "When and how I post" (or "When and how I work"),
-- "What I post about" (or the role's own name), "Do's and don'ts" and "Safety and legal". A customer
-- was sent looking for a card by a name she couldn't find (2026-11-14). Also: the Social wizard's
-- "Where should it look?" box was retired, so the article says where material to work from goes.
--
-- replace() on exact passages, so nothing else in the article is touched, and re-running is harmless.
-- ⚠️ RETURNING is load-bearing: expect ONE row. No row = the title differs — check before assuming.
-- ⚠️ Dollar-quoted: everything inside $h$…$h$ is literal. No semicolons inside the strings.

UPDATE help_articles
SET content_md =
    replace(replace(replace(replace(replace(replace(content_md,
        $h$## Mandate

The bottleneck this assistant was hired to solve.$h$,
        $h$## What I do

The bottleneck this assistant was hired to solve.$h$),
        $h$## Operational Setup

When the assistant runs and where its content comes from.$h$,
        $h$## When and how I post

When the assistant runs and where its content comes from. Assistants that don't post call this card **When and how I work**.$h$),
        $h$- **Content source** — you provide the material, the assistant researches it, or a mix.$h$,
        $h$- **Content source** — you provide the material, the assistant researches it, or a mix. Notes, links or posts you'd like it to work from go on its **Inspo** tab or under **Your brand**, which it reads when it drafts.$h$),
        $h$## Creative Brief

Objective and message, audience and voice, reference and visual style, and a strategy for each platform. Some assistants call this card something that fits their job better.$h$,
        $h$## What I post about

Objective and message, audience and voice, content pillars, reference and visual style, and a strategy for each platform. Some assistants call this card something that fits their job better, such as **How I write**.$h$),
        $h$## Rules
$h$,
        $h$## Do’s and don’ts
$h$),
        $h$## Brand Safety and Legal
$h$,
        $h$## Safety and legal
$h$),
    updated_at = now()
WHERE title = 'Assistant Settings'
RETURNING id, title,
    position('## What I do' in content_md) > 0 AS what_i_do,
    position('## When and how I post' in content_md) > 0 AS when_and_how,
    position('## Do’s and don’ts' in content_md) > 0 AS dos_donts,
    position('Mandate' in content_md) = 0 AS no_old_names;
