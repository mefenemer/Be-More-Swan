-- db/help-articles-2026-11-18-make-it-a-carousel.sql — Help Centre: "Make it a carousel" (18 November 2026)
--
-- Top lists Phase 2 (Instagram, Threads) and LinkedIn document carousels (docs/linkedin-document-carousel-plan.md,
-- PR #712) were live with no Help Centre words at all. LinkedIn's was posted for real on prod 2026-11-18 (post
-- #5777) before this was written, per the rule that public copy follows a real post.
--
-- APPEND to "Creating and Editing a Post", guarded by its new heading: a no-op when already applied, safe to
-- re-run. Body dollar-quoted (apostrophes NOT doubled), title single-quoted. No semicolons in the body. No schema
-- change. Apply to BOTH databases. The cost is the {{tasks.carousel}} token (db/help-articles-task-cost-tokens-2026-11-11.sql),
-- filled from Admin → Money → Task costs when the article is read.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Make it a carousel

When a post's caption has a numbered list (at least two items, like "1. …", "2. …"), press **Make it a carousel** in the post editor, or ask your Social Media Assistant in chat. It makes a cover slide and one branded slide per item, using the words already in your caption, so a slide never says something the post doesn't. The caption stays as it is.

- **Instagram and Threads:** the post switches to the Carousel format, with up to 20 slides.
- **LinkedIn:** the post switches to the **Document carousel** format. When it publishes, the slides go out as one PDF, which LinkedIn shows as a swipeable document titled with your caption's opening line. Slides must be PNG or JPEG pictures. Document carousels post to your personal LinkedIn feed.
- **Facebook and X** don't have a carousel format here, so those versions of the post are left alone.

Making a carousel uses {{tasks.carousel}}, however many slides or platforms it covers. You can reorder or remove slides in the editor before you approve, and the slides you see are the ones that go out.$$,
       updated_at = now()
 WHERE title = 'Creating and Editing a Post'
   AND content_md NOT LIKE '%## Make it a carousel%';

COMMIT;

-- Check (both databases):
-- SELECT position('## Make it a carousel' in content_md) > 0 AS has_section FROM help_articles WHERE title = 'Creating and Editing a Post';
