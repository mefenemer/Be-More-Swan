-- db/z-social-help-card-name-2026-11-14.sql — Help Centre: "The Social Media Assistant" still sent
-- customers to "Assistant Settings ▸ Operational Setup" for the posting schedule. That card is now
-- called "When and how I post" (z-assistant-settings-card-names-help-2026-11-14.sql renamed it in the
-- Assistant Settings article only).
--
-- replace() on the exact line, so nothing else in the article is touched, and re-running is harmless.
-- ⚠️ RETURNING is load-bearing: expect ONE row. No row = the title differs — check before assuming.
-- ⚠️ Dollar-quoted: everything inside $h$…$h$ is literal. No semicolons inside the strings.

UPDATE help_articles
SET content_md = replace(content_md,
        $h$under **Assistant Settings ▸ Operational Setup**$h$,
        $h$under **Assistant Settings ▸ When and how I post**$h$),
    updated_at = now()
WHERE title = 'The Social Media Assistant'
RETURNING title, content_md LIKE '%When and how I post%' AS renamed;
