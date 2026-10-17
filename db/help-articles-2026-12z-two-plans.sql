-- db/help-articles-2026-12z-two-plans.sql — Help Centre: two self-serve plans (17 October 2026)
--
-- Named "2026-12z" so it sorts AFTER db/help-articles-2026-12-tasks.sql, whose articles it edits.
--
-- The Digital Employee (£349) is no longer sold, and the £79 Busywork Buster now includes every
-- assistant (db/ops/retire-digital-employee.sql). The plan table in "Billing & Your Plan (from
-- October 2026)" and the AI video line in "What Counts as a Task" said otherwise. Existing Digital
-- Employee subscribers keep their plan; the article says so rather than pretending it never existed.
--
-- REPLACE on exact strings: a no-op when already applied, so the file is safe to re-run.

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(REPLACE(content_md,
         'Every plan includes the same assistants. Plans differ in how many can work at once and how many tasks they can do each month.',
         'There are two plans. The Workflow Saver runs one assistant of your choice; the Busywork Buster runs every assistant in the library. Both share one monthly task allowance.'),
         E'| **The Busywork Buster** | £79 / month | 3 | 2,750 |\n| **The Digital Employee** | £349 / month | 10 | 10,500 |',
         E'| **The Busywork Buster** | £79 / month | All of them | 2,750 |\n\nThe Digital Employee plan is no longer offered to new customers. If you are already on it, nothing changes: you keep its limits and price.\n\nNeed more than 2,750 tasks a month? Book a call about Custom Enterprise from the pricing page.'),
         '| Plan | Price | Assistants working at once | Tasks per month |',
         '| Plan | Price | Assistants | Tasks per month |'),
       updated_at = now()
 WHERE title = 'Billing & Your Plan (from October 2026)';

UPDATE help_articles
   SET content_md = REPLACE(content_md, '| An AI video (Busywork Buster and Digital Employee) | 20 |', '| An AI video (Busywork Buster) | 20 |'),
       updated_at = now()
 WHERE title = 'What Counts as a Task';
