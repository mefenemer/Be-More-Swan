-- db/help-articles-workspace-rules-2026-11-11.sql — Help Centre: a Do's and don'ts rule for every assistant
-- (FR#10, live on prod with PR #551). Adds a "### A rule for every assistant" part to 'Assistant Settings',
-- under its Rules list, so Ask Your Team (answers ONLY from published help_articles) can explain it.
--
-- Guarded: changes nothing where the Rules list's last line isn't there, or where this has already been
-- applied. Dollar-quoted bodies, no semicolons inside them. Code is live on both databases already, so
-- order doesn't matter:
--   node scripts/db-migrate.mjs apply --only help-articles-workspace-rules-2026-11-11 --execute --yes
--   node scripts/db-migrate.mjs apply --only help-articles-workspace-rules-2026-11-11 --url-var DATABASE_URL_PROD --execute --yes

BEGIN;

UPDATE help_articles
SET content_md = replace(content_md,
$old$- **Learned Directives** — rules it has learned from your corrections. Toggle one off to pause it, or delete it.
$old$,
$new$- **Learned Directives** — rules it has learned from your corrections. Toggle one off to pause it, or delete it.

### A rule for every assistant

Most rules belong to one assistant. To set one that all your assistants follow, choose **Every assistant** under **Who follows it** on any rule in **Assistant Rules**. It then shows on every assistant's list, marked **Every assistant**. Changing it, switching it off or deleting it changes it for all of them, and you're asked first.

You can also ask in chat. Tell any assistant, or your **Business Mentor**, something like "never mention a testimonials page in any material, for all my assistants". It shows a card for you to confirm, and nothing is saved until you do. Your Business Mentor only sets rules for every assistant. To change a rule for one assistant, ask that assistant or use its settings.

Only the workspace owner or an admin can set or change a rule for every assistant. Everyone else can see these rules but can't change them.
$new$),
    updated_at = NOW()
WHERE title = 'Assistant Settings'
  AND position($old$- **Learned Directives** — rules it has learned from your corrections. Toggle one off to pause it, or delete it.
$old$ in content_md) > 0
  AND position('### A rule for every assistant' in content_md) = 0
RETURNING id, title;

COMMIT;
