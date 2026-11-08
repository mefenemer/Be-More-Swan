-- db/z-rename-tab-buttons-help-2026-11-07.sql — Help Centre, owner decision 2026-11-07.
--
-- One tab header on every assistant: each tab's main button is now "+ New …" in sentence case, and the
-- Lead Generator's second button is sentence case too. Published articles still named the old buttons:
--   Create a Post      → New post            (Social Media Assistant, Posts tab)
--   Write Blog Post    → New blog post       (Blog Writing Assistant, Blogs tab)
--   Write Email        → New email           (Email Marketing Assistant, Emails tab)
--   Find New Leads     → New search          (Lead Generator, Searches tab)
--   Review Lead Ideas  → Review lead ideas   (Lead Generator, Searches tab)
-- Ask Your Team answers ONLY from published help_articles, so it would send people to buttons that no
-- longer exist until this runs.
--
-- Idempotent: REPLACE on exact strings is a no-op once applied. Each statement RETURNs, so the Neon SQL
-- editor shows what it changed. No semicolons inside string literals (the Neon editor splits pasted
-- scripts on them). Apply on staging and prod when the app change ships.

BEGIN;

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(content_md,
         'Create a Post', 'New post'),
         'Write Blog Post', 'New blog post'),
         'Write Email', 'New email'),
         'Find New Leads', 'New search'),
         'Review Lead Ideas', 'Review lead ideas'),
       updated_at = now()
 WHERE content_md LIKE '%Create a Post%'
    OR content_md LIKE '%Write Blog Post%'
    OR content_md LIKE '%Write Email%'
    OR content_md LIKE '%Find New Leads%'
    OR content_md LIKE '%Review Lead Ideas%'
RETURNING title, 'button names updated' AS result;

-- The Dashboard Overview listed the main action as "the big button below the header". It is now at the
-- right of each tab's header, beside Full screen.
UPDATE help_articles
   SET content_md = REPLACE(content_md,
         '- **The main action** — the big button below the header. It''s different for each assistant: *New post*, *New blog post*, *New email*, *Set an Objective*.',
         '- **The main action** — the pink "+ New …" button at the right of each tab''s header, beside **Full screen**. It''s different for each assistant: *New post*, *New blog post*, *New email*, *New campaign*, *New brief*, *New video*, *New search*, *New page*.'),
       updated_at = now()
 WHERE content_md LIKE '%the big button below the header%'
RETURNING title, 'main action line updated' AS result;

COMMIT;
