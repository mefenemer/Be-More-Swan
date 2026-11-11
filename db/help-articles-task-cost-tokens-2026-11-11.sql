-- db/help-articles-task-cost-tokens-2026-11-11.sql — task costs in help articles and plan features read live.
--
-- Help articles and plan feature descriptions wrote costs in ("1 task", "20 tasks"), so a change made in
-- Admin → Money → Task costs never reached them. They now say {{tasks.<cost key>}}, which
-- get-help-articles.ts, help-knowledge.ts (Ask Your Team) and get-plans.ts fill with today's figure
-- (fillTaskCostTokens, src/config/task-weights.ts) — "1 task", "20 tasks", or "4 tasks a second" for AI
-- video once it is priced by length. "What Counts as a Task" also gains the costs it was missing (footage
-- reviews, music shared, separate rows where the costs can differ).
--
-- APPLY MANUALLY in the Neon SQL Editor, on staging and prod separately. Idempotent: each statement only
-- touches a row that still has the old wording, and a row without it is left alone (RETURNING lists what
-- changed). Not changed on purpose: plan allowances ("2,750 tasks a month"), the 17 October 2026 credit
-- conversion (a record of what happened), and the fair-use limits (messages, not task costs).

BEGIN;

-- What Counts as a Task: the whole table, one row per cost.
UPDATE help_articles SET
    content_md = replace(content_md,
$old$| Work | Tasks |
|------|-------|
| A social post — once, however many platforms it goes to | 1 |
| A blog article | 1 |
| A lead search — once, however many leads it finds | 1 |
| An email, or an email flow | 1 |
| An outreach email to a lead | 1 |
| A website audit, draft or rewrite of a page's words | 1 |
| The words for a printable flyer | 1 |
| An AI voiceover | 1 |
| Removing a picture's background in the design editor | 1 |
| A Business Mentor research answer, drafted plan or weekly review | 1 each |
| A set of AI images — the editors give you up to 4 options to choose from | 1 |
| An AI video (Busywork Buster) | 20 |
| An AI music track | 20, or 12 if you share it with the Be More Swan community |
| A post to X with a link | 10 extra, on top of the post's own task |$old$,
$new$| Work | Tasks |
|------|-------|
| A social post — once, however many platforms it goes to | {{tasks.social_post}} |
| A blog article | {{tasks.blog_article}} |
| A lead search — once, however many leads it finds | {{tasks.lead_search}} |
| An email | {{tasks.email_issue}} |
| An email flow | {{tasks.email_campaign}} |
| An outreach email to a lead | {{tasks.outreach_email}} |
| A website audit (a check that re-scores your site) | {{tasks.site_audit}} |
| A website draft, or importing your current site | {{tasks.site_draft}} |
| Your own words placed on a website page | {{tasks.site_words}} |
| The words for a printable flyer | {{tasks.flyer_words}} |
| An AI voiceover | {{tasks.ai_voiceover}} |
| Removing a picture's background in the design editor | {{tasks.background_removal}} |
| A Business Mentor research answer | {{tasks.mentor_research}} |
| A plan your Business Mentor drafts for you | {{tasks.mentor_strategy}} |
| A Business Mentor weekly review | {{tasks.mentor_review}} |
| The Video Producer reviewing your own footage, the first time it watches a video | {{tasks.footage_review}} |
| A set of AI images — the editors give you up to 4 options to choose from | {{tasks.ai_image}} |
| An AI video (Busywork Buster) | {{tasks.ai_video}} |
| An AI music track | {{tasks.ai_music}}, or {{tasks.ai_music_shared}} if you share it with the Be More Swan community |
| A post to X with a link | {{tasks.x_link_post}} extra, on top of the post's own task |$new$),
    updated_at = now()
WHERE title = 'What Counts as a Task' AND content_md LIKE '%| An AI video (Busywork Buster) | 20 |%'
RETURNING title;

UPDATE help_articles SET
    content_md = replace(content_md,
        'A set of AI images is 1 task, an AI video or music track is 20, and a post to X with a link is 10 extra, on top of the post''s own task.',
        'A set of AI images is {{tasks.ai_image}}, an AI video {{tasks.ai_video}}, an AI music track {{tasks.ai_music}}, and a post to X with a link {{tasks.x_link_post}} extra, on top of the post''s own task.'),
    updated_at = now()
WHERE title = 'Billing & Your Plan (from October 2026)' AND content_md LIKE '%A set of AI images is 1 task, an AI video or music track is 20%'
RETURNING title;

UPDATE help_articles SET
    content_md = replace(replace(content_md,
        '**An AI-made picture (1 task)**', '**An AI-made picture ({{tasks.ai_image}})**'),
        'and uses 1 task once the background is removed', 'and uses {{tasks.background_removal}} once the background is removed'),
    updated_at = now()
WHERE title = 'Briefs and Your Brand Style'
  AND (content_md LIKE '%**An AI-made picture (1 task)**%' OR content_md LIKE '%and uses 1 task once the background is removed%')
RETURNING title;

UPDATE help_articles SET
    content_md = replace(content_md, 'Generating an image uses **1 task**', 'Generating an image uses **{{tasks.ai_image}}**'),
    updated_at = now()
WHERE title = 'Creating and Editing a Post' AND content_md LIKE '%Generating an image uses **1 task**%'
RETURNING title;

UPDATE help_articles SET
    content_md = replace(replace(content_md,
        '| Drafting the words | 1 task |', '| Drafting the words | {{tasks.flyer_words}} |'),
        '| An AI photo on a round | 1 task |', '| An AI photo on a round | {{tasks.ai_image}} |'),
    updated_at = now()
WHERE title = 'Making a Printed Flyer'
  AND (content_md LIKE '%| Drafting the words | 1 task |%' OR content_md LIKE '%| An AI photo on a round | 1 task |%')
RETURNING title;

UPDATE help_articles SET
    content_md = replace(content_md, 'Press **See the first frame**. That uses 1 task', 'Press **See the first frame**. That uses {{tasks.ai_image}}'),
    updated_at = now()
WHERE title = 'Making a Video: From Storyboard to Finished Post' AND content_md LIKE '%Press **See the first frame**. That uses 1 task%'
RETURNING title;

UPDATE help_articles SET
    content_md = replace(content_md,
        'Three things use **1 task each**, and only when they deliver: looking something up with sources, **Draft it for me** on a plan, and a written weekly review.',
        'Three things use tasks, and only when they deliver: looking something up with sources ({{tasks.mentor_research}}), **Draft it for me** on a plan ({{tasks.mentor_strategy}}), and a written weekly review ({{tasks.mentor_review}}).'),
    updated_at = now()
WHERE title = 'Meet Your Business Mentor' AND content_md LIKE '%Three things use **1 task each**%'
RETURNING title;

UPDATE help_articles SET
    content_md = replace(replace(content_md,
        '| AI images | 1 task for a round of four |', '| AI images | {{tasks.ai_image}} for a round of four |'),
        '| AI video | 20 tasks for one short clip', '| AI video | {{tasks.ai_video}} for one short clip'),
    updated_at = now()
WHERE title = 'The Brand Designer'
  AND (content_md LIKE '%| AI images | 1 task for a round of four |%' OR content_md LIKE '%| AI video | 20 tasks for one short clip%')
RETURNING title;

UPDATE help_articles SET
    content_md = replace(content_md, 'Press **Make the voiceover**. It uses 1 task.', 'Press **Make the voiceover**. It uses {{tasks.ai_voiceover}}.'),
    updated_at = now()
WHERE title = 'Voiceovers, Captions and Choosing a Voice' AND content_md LIKE '%Press **Make the voiceover**. It uses 1 task.%'
RETURNING title;

UPDATE help_articles SET
    content_md = replace(replace(content_md,
        'in the background, using 1 task.', 'in the background, using {{tasks.mentor_strategy}}.'),
        'A delivered answer uses 1 task.', 'A delivered answer uses {{tasks.mentor_research}}.'),
    updated_at = now()
WHERE title = 'Your Business and Marketing Plans'
  AND (content_md LIKE '%in the background, using 1 task.%' OR content_md LIKE '%A delivered answer uses 1 task.%')
RETURNING title;

UPDATE help_articles SET
    content_md = replace(content_md, 'A written review uses **1 task**.', 'A written review uses **{{tasks.mentor_review}}**.'),
    updated_at = now()
WHERE title = 'Your Weekly Review and Commitments' AND content_md LIKE '%A written review uses **1 task**.%'
RETURNING title;

-- Plan features on the Pricing page (get-plans.ts fills them).
UPDATE plan_features SET description = replace(description, '— 1 task each', '— {{tasks.ai_image}} each'), updated_at = now()
WHERE key = 'ai_image_generation' AND description LIKE '%— 1 task each%'
RETURNING key;
UPDATE plan_features SET description = replace(description, '— 20 tasks each', '— {{tasks.ai_video}} each'), updated_at = now()
WHERE key = 'ai_video_generation' AND description LIKE '%— 20 tasks each%'
RETURNING key;
UPDATE plan_features SET description = replace(description, 'AI clips use 20 tasks each', 'AI clips use {{tasks.ai_video}} each'), updated_at = now()
WHERE key = 'video_producer' AND description LIKE '%AI clips use 20 tasks each%'
RETURNING key;

COMMIT;
