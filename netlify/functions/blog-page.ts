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
//   GET /b/:key        → the hosted blog INDEX: a full-page, paged list of that widget's published
//                        posts (?cursor= for older pages). Exists for Wix, where pasted code lives
//                        in a fixed-size iframe — the owner points their Blog menu item here instead.
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
import { resolveCanonical, renderBlogPage, renderBlogIndexPage } from '../../src/utils/blog-seo';
import { parseBlogRoute, parseBlogIndexRoute, BlogIndexRoute } from '../../src/utils/blog-route';
import { parseCursor } from '../../src/utils/blog-list-paging';
import { listPublishedPosts } from '../../src/utils/blog-list-query';
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
function notFound(what: 'post' | 'blog' = 'post'): { statusCode: number; headers: Record<string, string>; body: string } {
    const title = what === 'blog' ? 'Blog not found' : 'Post not found';
    const text = what === 'blog' ? 'This blog is not available.' : 'This post is not available.';
    return htmlResponse(404,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
        `<title>${title}</title></head><body><p>${text}</p></body></html>`);
}

/**
 * Posts per page on the hosted index. Smaller than the widget's default 50: this is a page of image
 * cards a human scrolls, and each card's thumbnail is a presigned URL resolved per request.
 */
const INDEX_PAGE_SIZE = 12;

async function renderIndex(event: HandlerEvent, route: BlogIndexRoute) {
    const { publicKey } = route;
    const db = getDb();
    const [cfg] = await db
        .select({
            organisationId: widgetConfigs.organisationId,
            status: widgetConfigs.status,
            siteBaseUrl: widgetConfigs.siteBaseUrl,
            theme: widgetConfigs.theme,
            orgName: organisations.name,
            orgWebsiteUrl: organisations.websiteUrl,
        })
        .from(widgetConfigs)
        .leftJoin(organisations, eq(organisations.id, widgetConfigs.organisationId))
        .where(eq(widgetConfigs.publicKey, publicKey))
        .limit(1);
    if (!cfg || cfg.status !== 'active') return notFound('blog');

    const cursorId = parseCursor(event.queryStringParameters?.cursor);
    const { posts, nextCursor } = await listPublishedPosts(db, cfg.organisationId, { size: INDEX_PAGE_SIZE, cursorId });
    // A cursor that lands on nothing (stale, foreign, or made up) is not a page — 404 rather than
    // serve crawlers an empty, indexable-looking shell. Page 1 with no posts is a real, empty blog.
    if (cursorId && !posts.length) return notFound('blog');

    const origin = (resolveBaseUrl(event.headers as Record<string, string | undefined>) || '').replace(/\/+$/, '');
    const indexPath = route.pathname;
    const firstUrl = `${origin}${indexPath}`;
    const pageUrl = cursorId ? `${firstUrl}?cursor=${cursorId}` : firstUrl;

    const html = renderBlogIndexPage({
        siteName: cfg.orgName || 'Blog',
        pageUrl,
        // Page 1 is THE index. A cursor page is self-canonical and noindex,follow: its contents shift
        // every time a post is published (keyset pages are stable for a reader, not for an index),
        // so crawlers should follow its links to the permalinks and not index the page itself.
        canonicalUrl: pageUrl,
        robots: cursorId ? 'noindex,follow' : 'index,follow',
        posts: posts.map((p) => ({
            title: p.title,
            slug: p.slug,
            excerpt: p.excerpt,
            publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
            imageUrl: p.imageUrl,
            imageAlt: p.imageAlt,
        })),
        // Always OUR permalink, not the customer's site_post_path: the reason this page exists is
        // that the customer's site (Wix) has no per-post route of its own. The permalink still
        // carries the post's real canonical in its <head>.
        postHref: (slug) => `${indexPath}/${encodeURIComponent(slug)}`,
        olderHref: nextCursor ? `${indexPath}?cursor=${encodeURIComponent(nextCursor)}` : null,
        firstHref: cursorId ? indexPath : null,
        homeUrl: cfg.siteBaseUrl || cfg.orgWebsiteUrl || null,
        theme: (cfg.theme as { fontFamily?: string | null; fontUrl?: string | null } | null) || null,
    });
    return htmlResponse(200, html, true);
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    // Parse the original (pre-rewrite) path — a rewrite is status 200, so rawUrl still carries the
    // URL the visitor actually requested, which is the only place the key and slug survive.
    const path = event.rawUrl ? new URL(event.rawUrl).pathname : event.path || '';
    const indexRoute = parseBlogIndexRoute(path);
    if (indexRoute) return renderIndex(event, indexRoute);
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
        // The organisation, NOT post.ownerLabel. ownerLabel is the internal creator label — for an
        // assistant-drafted post it is literally "AI: Lyra", which is what this page published as
        // its byline and as a schema.org Person until now. Who inside the workspace drafted a post
        // is not the public author of it; the brand is. AI involvement is disclosed by the
        // transparency badge, which is the mechanism actually designed for it.
        // org.name, NOT siteName — siteName falls back to the literal 'Blog', which is a fine
        // og:site_name and a ridiculous byline ("By Blog"). No name means no byline.
        authorName: org?.name || null,
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
        // Back to the list the reader came from: our own /blog page for the marketing-domain route,
        // the hosted index for a tenant permalink.
        indexUrl: route.pathname.startsWith('/blog/') ? '/blog' : `/b/${encodeURIComponent(publicKey)}`,
    });

    // Never cache a noindex post at the CDN as if indexable; still fine for the browser.
    const cacheable = (post.robots || 'index,follow').startsWith('index');
    return htmlResponse(200, html, cacheable);
});
