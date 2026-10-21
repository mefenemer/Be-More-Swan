-- db/help-articles-blog-setup-2026-10-21.sql
-- Search Console and the blog widget moved out of every post's Blog Studio editor into "Blog setup"
-- (a button on the Blog Writer's Blogs tab). Two live help articles told people to find them in
-- Blog Studio. This points them at the new place. The source files (seed-help-articles.sql,
-- help-article-blog-publishing-update.sql, help-articles-2026-10.sql) carry the same wording.
--
-- replace() on the exact sentences, so nothing else in either article is touched, and re-running
-- it is harmless (the old text is no longer there to replace).
-- ⚠️ RETURNING is load-bearing: expect ONE row from each statement. No row means the title or the
--    live wording differs from the source files — check before assuming it applied.
-- ⚠️ Dollar-quoted: everything inside $h$…$h$ is literal.

UPDATE help_articles
SET content_md = replace(replace(content_md,
        $h$1. Open your Blog Writing Assistant and click **Write Blog Post**. This opens Blog Studio.
2. On the left, find the **Widget** panel.$h$,
        $h$1. Open your Blog Writing Assistant. On its **Blogs** tab, click **Blog setup**.
2. Open the **Blog widget** section.$h$),
        $h$**Search performance** panel in Blog Studio — they are the same connection, so either will do.$h$,
        $h$**Search performance** section of **Blog setup** on the Blogs tab — they are the same connection, so either will do.$h$),
    updated_at = now()
WHERE title = 'Publishing Your Blog to Your Own Website'
RETURNING id, title, position('Blog setup' in content_md) > 0 AS now_says_blog_setup;

UPDATE help_articles
SET content_md = replace(content_md,
        $h$Connect **Google Search Console** from Blog Studio to see impressions$h$,
        $h$Connect **Google Search Console** from **Blog setup** on the Blogs tab to see impressions$h$),
    updated_at = now()
WHERE title = 'The Blog Writing Assistant'
RETURNING id, title, position('Blog setup' in content_md) > 0 AS now_says_blog_setup;
