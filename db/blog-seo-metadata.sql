-- Autonomous Content Engine — crawler-facing blog metadata (US 1.3 extension).
--
-- Context: blog_posts already carries meta_title/meta_description/slug/canonical_url/tags, and
-- generate-seo.ts already populates the first four. What was missing is the LAST MILE — nothing
-- ever emitted a <head>. It could not: the native widget (widget.js) renders client-side into a
-- Shadow DOM on the CUSTOMER's domain and routes on location.hash, and
--   · social crawlers (LinkedIn/Slack/X/Facebook) execute no JavaScript at all, and
--   · Google has ignored #fragments for indexing since the AJAX crawling scheme was retired,
-- so every post shared one hash-less URL with no metadata. The fix is a server-rendered post route
-- (netlify/functions/blog-page.ts, /b/:key/:slug) that emits real HTML. These columns feed it.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

-- ---------------------------------------------------------------------------------------------
-- widget_configs: where the customer actually publishes, so canonical can credit THEIR domain.
-- ---------------------------------------------------------------------------------------------
-- site_base_url + site_post_path together reconstruct the public per-post URL on the customer's
-- own site, e.g. ('https://acme.com', '/blog/{slug}') → https://acme.com/blog/my-post.
--
-- Both nullable and BOTH are required before we will canonicalise to the customer. This is not
-- defensiveness — it is correctness. A widget embedded at acme.com/blog serves every post from
-- that ONE url (hash routing), so canonicalising all posts to site_base_url alone would tell
-- Google that fifty distinct posts are duplicates of a single page and collapse the whole blog.
-- Worse than no canonical. Without a per-post path we self-canonicalise to /b/:key/:slug instead.
-- See src/utils/blog-seo.ts resolveCanonical().
ALTER TABLE widget_configs ADD COLUMN IF NOT EXISTS site_base_url  TEXT;
ALTER TABLE widget_configs ADD COLUMN IF NOT EXISTS site_post_path TEXT;

-- site_post_path must be a rooted path containing the {slug} placeholder — that placeholder is the
-- only thing making the URL per-post, so a pattern without it is the collapse bug described above.
ALTER TABLE widget_configs DROP CONSTRAINT IF EXISTS widget_configs_site_post_path_check;
ALTER TABLE widget_configs ADD  CONSTRAINT widget_configs_site_post_path_check
  CHECK (site_post_path IS NULL OR (site_post_path LIKE '/%' AND site_post_path LIKE '%{slug}%'));

-- ---------------------------------------------------------------------------------------------
-- blog_posts: per-post crawler directives.
-- ---------------------------------------------------------------------------------------------
-- robots: the <meta name="robots"> value for the hosted page. Default indexable; authors can set
-- 'noindex,nofollow' on a post they want live but unlisted. Constrained rather than free text so a
-- typo can't silently de-index a customer's blog.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS robots TEXT NOT NULL DEFAULT 'index,follow';

ALTER TABLE blog_posts DROP CONSTRAINT IF EXISTS blog_posts_robots_check;
ALTER TABLE blog_posts ADD  CONSTRAINT blog_posts_robots_check
  CHECK (robots IN ('index,follow','index,nofollow','noindex,follow','noindex,nofollow'));

-- ---------------------------------------------------------------------------------------------
-- Backfill: canonical_url was READ by three syndication adapters (devto/ghost/hashnode) and by
-- ingest-gsc-metrics, but written by NOTHING — so it was always NULL. Two live consequences:
--   · syndicated copies shipped with no canonical, creating the duplicate-content problem the
--     adapters were written to avoid;
--   · ingest-gsc-metrics filters isNotNull(canonical_url), so content-decay detection (US 5.1)
--     silently matched zero rows on every run — a permanently no-op feature.
-- publishBlogPost() now stamps canonical_url on publish. Backfill the posts already published so
-- decay detection starts seeing them, using the same resolution order as the runtime helper.
UPDATE blog_posts p
   SET canonical_url = CASE
         WHEN w.site_base_url IS NOT NULL AND w.site_post_path IS NOT NULL
           THEN rtrim(w.site_base_url, '/') || replace(w.site_post_path, '{slug}', p.slug)
         ELSE NULL   -- self-canonical: needs the deploy URL, which SQL has no business guessing.
       END           -- publish-blog-posts/republish fills these in; see blog-seo.ts.
  FROM widget_configs w
 WHERE w.organisation_id = p.organisation_id
   AND p.status          = 'published'
   AND p.slug           IS NOT NULL
   AND p.canonical_url  IS NULL
   AND w.site_base_url  IS NOT NULL
   AND w.site_post_path IS NOT NULL;
