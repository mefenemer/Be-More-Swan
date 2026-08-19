// netlify/functions/blog-page.ts
// Autonomous Content Engine — US 1.3: the SERVER-RENDERED permalink for a published blog post.
//
// Behind two netlify.toml rewrites, both landing here:
//   GET /b/:key/:slug  → a full HTML document with a crawler-facing <head> (SEO + Open Graph +
//                        Twitter Card + JSON-LD BlogPosting) and the server-rendered article body.
//                        Tenant-neutral: the widget key is in the URL.
//   GET /blog/:slug    → the SAME document for Be More Swan's own blog, where the key is implied by
//                        the domain (SITE_BLOG_WIDGET_KEY). This exists because our prod widget
//                        config stamps canonicals at bemoreswan.com/blog/<slug> — before this route
//                        nothing served that path, so every canonical and sitemap entry 404'd.
//                        See src/utils/blog-route.ts for the parsing.
//
// WHY this exists alongside widget-api.ts: the native widget renders client-side into a Shadow DOM
// on the customer's domain and routes on location.hash. Social crawlers run no JavaScript, and
// Google ignores #fragments for indexing — so the widget can deliver no metadata and no indexable
// per-post URL. This route is the real, crawlable, shareable unit. Public + read-only, keyed by the
// same unguessable widget public_key (no id enumeration; only that org's PUBLISHED posts).

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs, blogPosts, organisations } from '../../db/schema';
import { resolveInlineMedia, resolveFeatureImageUrl } from '../../src/utils/blog-media-resolve';
import { resolveCanonical, renderBlogPage } from '../../src/utils/blog-seo';
import { parseBlogRoute } from '../../src/utils/blog-route';
import { isAiAssisted } from '../../src/utils/blog-ai-assisted';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { excerpt } from '../../src/utils/markdown-render';
import { withLambda } from '@netlify/aws-lambda-compat';

// s-maxage under the presigned-URL lifetime (600s) so a cached page never serves a dead media src.
const CACHE = 'public, max-age=120, s-maxage=300';

function htmlResponse(statusCode: number, body: string, cache = false) {
    return {
        statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...(cache ? { 'Cache-Control': CACHE } : {}) },
        body,
    };
}

// A minimal, indexable-but-empty page for the not-found case. noindex so a bad link never gets
// crawled as thin content.
function notFound(): { statusCode: number; headers: Record<string, string>; body: string } {
    return htmlResponse(404,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
        `<title>Post not found</title></head><body><p>This post is not available.</p></body></html>`);
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    // Parse the original (pre-rewrite) path — a rewrite is status 200, so rawUrl still carries the
    // URL the visitor actually requested, which is the only place the key and slug survive.
    const path = event.rawUrl ? new URL(event.rawUrl).pathname : event.path || '';
    const route = parseBlogRoute(path);
    if (!route) return notFound();
    const { publicKey, slug } = route;

    const db = getDb();
    const [cfg] = await db
        .select({
            organisationId: widgetConfigs.organisationId,
            status: widgetConfigs.status,
            siteBaseUrl: widgetConfigs.siteBaseUrl,
            sitePostPath: widgetConfigs.sitePostPath,
            badgeEnabled: widgetConfigs.badgeEnabled,
            // Read so the permalink honours the author's chosen font. It previously did not, so a
            // font applied on the customer's embed and NOT on the page we serve to crawlers.
            theme: widgetConfigs.theme,
        })
        .from(widgetConfigs)
        .where(eq(widgetConfigs.publicKey, publicKey))
        .limit(1);
    if (!cfg || cfg.status !== 'active') return notFound();

    const orgId = cfg.organisationId;

    const [post] = await db
        .select({
            title: blogPosts.title,
            slug: blogPosts.slug,
            publishedPayload: blogPosts.publishedPayload,
            metaTitle: blogPosts.metaTitle,
            metaDescription: blogPosts.metaDescription,
            robots: blogPosts.robots,
            tags: blogPosts.tags,
            canonicalUrl: blogPosts.canonicalUrl,
            ownerLabel: blogPosts.ownerLabel,
            publishedAt: blogPosts.publishedAt,
            updatedAt: blogPosts.updatedAt,
            jobId: blogPosts.jobId,
            blueprintId: blogPosts.blueprintId,
            isAutonomous: blogPosts.isAutonomous,
            generationReason: blogPosts.generationReason,
        })
        .from(blogPosts)
        .where(and(
            eq(blogPosts.organisationId, orgId),
            eq(blogPosts.slug, slug),
            eq(blogPosts.status, 'published'),
        ))
        .limit(1);
    if (!post) return notFound();

    const [org] = await db
        .select({ name: organisations.name, websiteUrl: organisations.websiteUrl })
        .from(organisations)
        .where(eq(organisations.id, orgId))
        .limit(1);
    const siteName = org?.name || 'Blog';

    // Resolve fresh media URLs from the immutable snapshot (same read-time resolution as widget-api).
    const payload = (post.publishedPayload as Record<string, any> | null) || null;
    let bodyHtml: string = (payload && typeof payload.html === 'string') ? payload.html : '';
    if (bodyHtml) bodyHtml = await resolveInlineMedia(db, orgId, bodyHtml);
    const imageUrl = await resolveFeatureImageUrl(db, orgId, payload?.featureImage?.assetId);
    const imageAlt = (payload?.featureImage?.alt as string | undefined) || post.title;

    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);
    // og:url is the URL THIS response was served at, not the canonical — route.pathname keeps the
    // two apart, so a post opened at /blog/<slug> does not advertise the /b/<key>/<slug> form.
    const pageUrl = `${(baseUrl || '').replace(/\/+$/, '')}${route.pathname}`;

    // Prefer the stamped canonical_url (set at publish); recompute as a fallback for posts published
    // before the column was backfilled. Both go through the same resolver so they can't diverge.
    const canonicalUrl = post.canonicalUrl || resolveCanonical({
        slug: post.slug,
        siteBaseUrl: cfg.siteBaseUrl,
        sitePostPath: cfg.sitePostPath,
        publicKey,
        baseUrl,
    });

    const description = post.metaDescription || await excerpt(String(payload?.html || ''), 200) || siteName;

    const html = renderBlogPage({
        title: post.metaTitle || post.title,
        // The VISIBLE heading is the post's own title. `title` above stays the SEO string, which
        // carries a site suffix and belongs in <title>/og:title, not in 2.25rem type on the page.
        heading: post.title || post.metaTitle,
        description,
        pageUrl,
        canonicalUrl,
        robots: post.robots || 'index,follow',
        imageUrl,
        imageAlt,
        tags: Array.isArray(post.tags) ? (post.tags as string[]) : [],
        publishedAt: post.publishedAt ? new Date(post.publishedAt).toISOString() : null,
        modifiedAt: post.updatedAt ? new Date(post.updatedAt).toISOString() : null,
        authorName: post.ownerLabel || null,
        publisher: { name: siteName, logoUrl: null },
        siteName,
        bodyHtml,
        aiAssisted: isAiAssisted(post),
        badgeEnabled: cfg.badgeEnabled,
        theme: (cfg.theme as { fontFamily?: string | null; fontUrl?: string | null } | null) || null,
        // Anonymous dwell/scroll beacon, the same one widget.js sends. Without it this page — the
        // one every shared link, search result and canonical points at — contributed NOTHING to
        // blog_engagement_stats, so "Average Read Time" only ever measured reads that happened
        // inside a customer's embed. Keyed on the resolved public key + the STORED slug, so the
        // row it upserts is the same one the widget would have written.
        engagement: post.slug ? { publicKey, slug: post.slug } : null,
    });

    // Never cache a noindex post at the CDN as if indexable; still fine for the browser.
    const cacheable = (post.robots || 'index,follow').startsWith('index');
    return htmlResponse(200, html, cacheable);
});
