// src/config/site-blog.ts
// Be More Swan's OWN blog on bemoreswan.com — the facts shared by the server route and the page.
//
// ── Why this file exists ────────────────────────────────────────────────────────────────────────
// blog.html mounts our own customer-facing widget at #bms-blog, and the widget is client-rendered
// and hash-routed, so it can never be an indexable per-post URL. `/b/:key/:slug` (blog-page.ts) is
// that URL for every tenant — but for US it reads as somebody else's permalink, and our prod widget
// config has site_base_url + site_post_path = "/blog/{slug}" set, which stamps every canonical at
// bemoreswan.com/blog/<slug>. Nothing served that path, so every canonical and every sitemap entry
// pointed at a 404. This constant is what lets `/blog/:slug` resolve to our org without turning a
// public route into a tenant-guessing exercise.
//
// ⚠️ The key is a PUBLIC identifier by design — it ships inside a <script> tag on customers' sites —
// so it belongs in source, not an env var. It is the same value blog.html carries in
// BMS_BLOG_WIDGET_KEY, and tests/blog-site-route.test.ts fails the build if the two ever diverge.
//
// ⚠️ Keys are per-organisation AND per-database. This one is the PRODUCTION workspace's; a key
// minted on staging resolves to nothing here and every /blog/<slug> would 404.
export const SITE_BLOG_WIDGET_KEY = 'wgt_a29af16bd7af9af3499cd70c';

// The public path pattern for one post, matching widget_configs.site_post_path in the prod row.
// Kept here so the route, the widget's links and the drift test all read the same string.
export const SITE_BLOG_POST_PATH = '/blog/{slug}';
