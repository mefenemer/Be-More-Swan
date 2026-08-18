// src/utils/blog-seo.ts
// Autonomous Content Engine — US 1.3: crawler-facing blog metadata.
//
// blog_posts already CARRIES meta_title/meta_description/slug/canonical_url/tags/robots and
// generate-seo.ts populates them, but nothing ever turned that data into a <head>. It could not:
// the native widget renders client-side into a Shadow DOM on the customer's domain and routes on
// location.hash, and social crawlers run no JavaScript while Google ignores #fragments for indexing.
//
// So the data is delivered by a SERVER-RENDERED permalink (netlify/functions/blog-page.ts,
// /b/:key/:slug) that emits real HTML. This module owns three concerns for that page:
//   · resolveCanonical()  — decide the one canonical URL for a post (also stamped at publish time);
//   · buildHeadTags()     — the SEO + Open Graph + Twitter Card + JSON-LD tags for the <head>;
//   · renderBlogPage()    — the full standalone HTML document a crawler / human receives.

import { BLOG_AI_NOTICE } from './blog-ai-assisted';

// ── escaping ───────────────────────────────────────────────────────────────────────────────────
// HTML text/attribute escape. Applied to every interpolated value except bodyHtml, which is the
// already-sanitised published_payload snapshot (allowlisted at publish time) and must stay markup.
export function escHtml(v: unknown): string {
    return String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Serialise a value for embedding inside a <script type="application/ld+json"> block. JSON.stringify
// handles quoting; we additionally neutralise '<' so a value containing "</script>" (or "<!--")
// cannot break out of the script element. See OWASP JSON-in-HTML guidance.
function jsonLdSafe(obj: unknown): string {
    return JSON.stringify(obj).replace(/</g, '\\u003c');
}

// ── canonical resolution ─────────────────────────────────────────────────────────────────────
export interface CanonicalInput {
    slug: string | null;
    /** widget_configs.site_base_url — the customer's own site origin, e.g. 'https://acme.com'. */
    siteBaseUrl?: string | null;
    /** widget_configs.site_post_path — rooted path with a {slug} placeholder, e.g. '/blog/{slug}'. */
    sitePostPath?: string | null;
    /** widget public key, for the self-canonical /b/:key/:slug fallback. */
    publicKey?: string | null;
    /** this app's own origin (resolveBaseUrl), for the self-canonical fallback. */
    baseUrl?: string | null;
}

/**
 * The single canonical URL for a published post. Resolution order:
 *   1. The customer's own site — ONLY when BOTH site_base_url and site_post_path are set. This is a
 *      hard requirement, not defensiveness: the widget serves every post from ONE hash-routed URL,
 *      so canonicalising to site_base_url alone would declare the whole blog duplicates of one page.
 *      The {slug} placeholder in site_post_path is the only thing making the URL per-post.
 *   2. Our own server-rendered permalink /b/:key/:slug — a real, per-post, crawlable URL we control.
 *   3. null — not enough to build either (caller omits <link rel=canonical>).
 */
export function resolveCanonical(input: CanonicalInput): string | null {
    const slug = input.slug?.trim();
    if (!slug) return null;

    if (input.siteBaseUrl && input.sitePostPath && input.sitePostPath.includes('{slug}')) {
        const base = input.siteBaseUrl.replace(/\/+$/, '');
        const path = input.sitePostPath.replace('{slug}', encodeURIComponent(slug));
        return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    }

    if (input.baseUrl && input.publicKey) {
        return `${input.baseUrl.replace(/\/+$/, '')}/b/${encodeURIComponent(input.publicKey)}/${encodeURIComponent(slug)}`;
    }

    return null;
}

// ── head tags ────────────────────────────────────────────────────────────────────────────────
export interface BlogHeadData {
    title: string;              // <title> + og:title — prefer metaTitle, fall back to the post title
    description: string;        // meta description + og:description
    pageUrl: string;            // the /b/:key/:slug URL this page is served at (og:url)
    canonicalUrl: string | null;
    robots: string;             // 'index,follow' | 'noindex,nofollow' | …
    imageUrl: string | null;    // absolute og:image (resolved feature image), if any
    imageAlt: string | null;
    tags: string[];
    publishedAt: string | null; // ISO 8601
    modifiedAt: string | null;  // ISO 8601
    authorName: string | null;
    publisher: { name: string; logoUrl: string | null };
    siteName: string;           // og:site_name — the org's blog/site name
}

// Emit the full set of crawler-facing tags for the document <head>: core SEO (title/description/
// robots/canonical), Open Graph, Twitter Card, and a JSON-LD BlogPosting. Returns a string of tags
// (no surrounding <head>). Every dynamic value is escaped; the JSON-LD block is jsonLdSafe.
export function buildHeadTags(d: BlogHeadData): string {
    const title = d.title || d.siteName;
    const twitterCard = d.imageUrl ? 'summary_large_image' : 'summary';

    const tags: string[] = [
        `<title>${escHtml(title)}</title>`,
        `<meta name="description" content="${escHtml(d.description)}">`,
        `<meta name="robots" content="${escHtml(d.robots || 'index,follow')}">`,
    ];
    if (d.canonicalUrl) tags.push(`<link rel="canonical" href="${escHtml(d.canonicalUrl)}">`);
    if (d.tags?.length) tags.push(`<meta name="keywords" content="${escHtml(d.tags.join(', '))}">`);

    // Open Graph — the cross-platform standard (LinkedIn / Slack / Facebook / …).
    tags.push(
        `<meta property="og:type" content="article">`,
        `<meta property="og:title" content="${escHtml(title)}">`,
        `<meta property="og:description" content="${escHtml(d.description)}">`,
        `<meta property="og:url" content="${escHtml(d.pageUrl)}">`,
        `<meta property="og:site_name" content="${escHtml(d.siteName)}">`,
    );
    if (d.imageUrl) {
        tags.push(`<meta property="og:image" content="${escHtml(d.imageUrl)}">`);
        if (d.imageAlt) tags.push(`<meta property="og:image:alt" content="${escHtml(d.imageAlt)}">`);
    }
    if (d.publishedAt) tags.push(`<meta property="article:published_time" content="${escHtml(d.publishedAt)}">`);
    if (d.modifiedAt) tags.push(`<meta property="article:modified_time" content="${escHtml(d.modifiedAt)}">`);
    if (d.authorName) tags.push(`<meta property="article:author" content="${escHtml(d.authorName)}">`);
    for (const t of d.tags || []) tags.push(`<meta property="article:tag" content="${escHtml(t)}">`);

    // Twitter Card — X's proprietary set; falls back to OG for anything omitted.
    tags.push(
        `<meta name="twitter:card" content="${twitterCard}">`,
        `<meta name="twitter:title" content="${escHtml(title)}">`,
        `<meta name="twitter:description" content="${escHtml(d.description)}">`,
    );
    if (d.imageUrl) tags.push(`<meta name="twitter:image" content="${escHtml(d.imageUrl)}">`);

    // Structured data — Schema.org BlogPosting (JSON-LD), enabling rich results.
    const ld: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: title,
        description: d.description,
        mainEntityOfPage: { '@type': 'WebPage', '@id': d.canonicalUrl || d.pageUrl },
        url: d.pageUrl,
    };
    if (d.imageUrl) ld.image = [d.imageUrl];
    if (d.publishedAt) ld.datePublished = d.publishedAt;
    if (d.modifiedAt) ld.dateModified = d.modifiedAt;
    if (d.authorName) ld.author = { '@type': 'Person', name: d.authorName };
    if (d.tags?.length) ld.keywords = d.tags.join(', ');
    ld.publisher = {
        '@type': 'Organization',
        name: d.publisher.name,
        ...(d.publisher.logoUrl ? { logo: { '@type': 'ImageObject', url: d.publisher.logoUrl } } : {}),
    };
    tags.push(`<script type="application/ld+json">${jsonLdSafe(ld)}</script>`);

    return tags.join('\n    ');
}

// ── full page ────────────────────────────────────────────────────────────────────────────────
export interface BlogPageData extends BlogHeadData {
    bodyHtml: string;           // resolved, sanitised published_payload HTML (kept as markup)
    aiAssisted: boolean;
    badgeEnabled: boolean;
}

// A self-contained, dependency-free HTML document. Server-rendered so crawlers (which run no JS) and
// social unfurlers get the real title/description/image and full article text — the exact thing the
// hash-routed Shadow-DOM widget cannot give them.
export function renderBlogPage(d: BlogPageData): string {
    const head = buildHeadTags(d);
    const dateLine = d.publishedAt
        ? `<time datetime="${escHtml(d.publishedAt)}">${escHtml(new Date(d.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</time>`
        : '';
    const byline = d.authorName ? `<span>By ${escHtml(d.authorName)}</span>` : '';
    const hero = d.imageUrl
        ? `<img class="hero" src="${escHtml(d.imageUrl)}" alt="${escHtml(d.imageAlt || d.title)}">`
        : '';
    const badge = (d.aiAssisted && d.badgeEnabled)
        ? `<p class="ai-badge">✨ ${escHtml(BLOG_AI_NOTICE)}</p>`
        : '';
    const tagList = d.tags?.length
        ? `<ul class="tags">${d.tags.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>`
        : '';

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${head}
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.65; color: #1a1a1a; background: #fff; }
      main { max-width: 720px; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
      h1 { font-size: 2.25rem; line-height: 1.2; margin: 0 0 .5rem; letter-spacing: -.02em; }
      .meta { color: #666; font-size: .95rem; margin: 0 0 2rem; display: flex; gap: 1rem; flex-wrap: wrap; }
      .hero { width: 100%; height: auto; border-radius: 12px; margin: 0 0 2rem; }
      article { font-size: 1.075rem; }
      article img, article video { max-width: 100%; height: auto; border-radius: 8px; }
      article figure { margin: 1.75rem 0; }
      article figure figcaption { font-size: .9rem; color: #666; text-align: center; margin-top: .5rem; }
      article .bms-columns { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      article a { color: #d6006e; }
      .ai-badge { font-size: .9rem; color: #666; border: 1px solid #eee; border-radius: 8px; padding: .6rem .9rem; background: #fafafa; }
      .tags { list-style: none; padding: 0; margin: 2.5rem 0 0; display: flex; gap: .5rem; flex-wrap: wrap; }
      .tags li { font-size: .8rem; color: #666; background: #f2f2f2; border-radius: 999px; padding: .25rem .75rem; }
      @media (prefers-color-scheme: dark) {
        body { color: #e8e8e8; background: #131313; }
        .meta, .ai-badge, .tags li, article figure figcaption { color: #9a9a9a; }
        .ai-badge { background: #1c1c1c; border-color: #2a2a2a; }
        .tags li { background: #222; }
        article a { color: #ff5aa8; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escHtml(d.title)}</h1>
      <div class="meta">${[byline, dateLine].filter(Boolean).join('')}</div>
      ${hero}
      ${badge}
      <article>${d.bodyHtml}</article>
      ${tagList}
    </main>
  </body>
</html>`;
}
