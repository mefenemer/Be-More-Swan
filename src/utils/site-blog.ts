// src/utils/site-blog.ts
// The Blog Assistant's posts on a hosted Website Assistant site: /blog (the list), /blog/<slug> (one
// post) and the `blog_posts` section (the newest few, on any page).
//
// Why not the embed: a hosted page allows no script at all (site-serve.ts CSP), so the Blog Studio
// widget can't run there. It doesn't need to — blog-page.ts already draws every published post on the
// server; this reads the same rows (blog_posts, status 'published', by organisation — the same query
// as the widget and the /b/:key index, blog-list-query.ts) and site-render.ts draws them in the site's
// own look. The site holds no posts: publishing in the Blog Assistant puts a post on the site at once.
//
// Canonical: a post's canonical_url is stamped when it is published (from the widget's settings).
// When that already names this site — Restorative Futures' posts point at
// www.restorativefutures.co.uk/blog/<slug> — the page keeps it. When it names our own /b/:key
// permalink (the default for a workspace whose widget never named a site) the hosted page is the
// better home, so it points at itself. A post stamped at some OTHER site keeps that canonical: it was
// published there first and the hosted copy must not compete with it.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts } from '../../db/schema';
import { listPublishedPosts } from './blog-list-query';
import { parseCursor } from './blog-list-paging';
import { resolveFeatureImageUrl, resolveInlineMedia } from './blog-media-resolve';
import { excerpt } from './markdown-render';
import { BLOG_PATH, blogOn, type SiteDefinition } from './site-definition';

type Db = ReturnType<typeof getDb>;

/** Posts on one page of /blog. */
export const SITE_BLOG_PAGE_SIZE = 12;

export interface SiteBlogCard {
    title: string;
    slug: string;
    excerpt: string;
    publishedAt: string | null;
    imageUrl: string | null;
    imageAlt: string;
}
/** What the `blog_posts` sections on a page may show: the newest posts, enough for the largest count. */
export interface SiteRenderBlog { posts: SiteBlogCard[]; }

export interface SiteBlogIndex { posts: SiteBlogCard[]; olderCursor: string | null; cursor: number | null; }

export interface SiteBlogPost {
    title: string;
    slug: string;
    metaTitle: string | null;
    description: string;
    bodyHtml: string;
    imageUrl: string | null;
    imageAlt: string;
    tags: string[];
    publishedAt: string | null;
    modifiedAt: string | null;
    canonicalUrl: string;
    robots: string;
}

/** Which blog page a path asks for, or null when it isn't one. Pure. */
export type SiteBlogRoute = { kind: 'index' } | { kind: 'post'; slug: string };
export function siteBlogRoute(path: string): SiteBlogRoute | null {
    const clean = (path || '').split(/[?#]/)[0];
    if (clean === BLOG_PATH || clean === `${BLOG_PATH}/`) return { kind: 'index' };
    // Exactly one segment after /blog — /blog/a/b is not a post (the blog-route.ts trap).
    const m = /^\/blog\/([^/]+)\/?$/.exec(clean);
    if (!m) return null;
    let slug: string;
    try { slug = decodeURIComponent(m[1]); } catch { return null; }
    return slug && slug.length <= 200 ? { kind: 'post', slug } : null;
}

const iso = (d: Date | string | null | undefined): string | null => {
    if (!d) return null;
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/**
 * The canonical address of a post shown on this site (see the header). Pure. `origins` are every
 * address the site answers at (its own domain, the other form of it, its bemoreswan.site address).
 */
export function siteBlogCanonical(stamped: string | null | undefined, slug: string, origin: string, origins: string[] = []): string {
    const own = `${origin}${BLOG_PATH}/${encodeURIComponent(slug)}`;
    if (!stamped) return own;
    let u: URL;
    try { u = new URL(stamped); } catch { return own; }
    if (u.protocol !== 'https:') return own;
    if (canonicalIsHere(stamped, origin, origins)) return u.toString();
    // Our own permalink (/b/<key>/<slug>, or /blog/<slug> on bemoreswan.com): the hosted page is the home.
    if (/(^|\.)bemoreswan\.com$/.test(u.host)) return own;
    return u.toString();
}

const toCard = (p: { title: string; slug: string; excerpt: string; publishedAt: Date | string | null; imageUrl: string | null; imageAlt: string }): SiteBlogCard => ({
    title: p.title, slug: p.slug, excerpt: p.excerpt, publishedAt: iso(p.publishedAt), imageUrl: p.imageUrl, imageAlt: p.imageAlt,
});

/** The newest posts every `blog_posts` section on the site may need; null when none is on (nothing is read). */
export async function loadSiteBlogLatest(db: Db, orgId: number, def: SiteDefinition): Promise<SiteRenderBlog | null> {
    const counts = def.pages.flatMap((p) => p.sections.flatMap((s) => (s.type === 'blog_posts' && s.props.enabled ? [s.props.count] : [])));
    if (!counts.length || !blogOn(def)) return null;
    const { posts } = await listPublishedPosts(db, orgId, { size: Math.max(...counts), cursorId: null });
    return { posts: posts.filter((p) => p.slug).map(toCard) };
}

/** One page of /blog. `cursorRaw` is ?cursor= from the "Older posts" link. */
export async function loadSiteBlogIndex(db: Db, orgId: number, cursorRaw: string | null): Promise<SiteBlogIndex> {
    const cursor = parseCursor(cursorRaw);
    const { posts, nextCursor } = await listPublishedPosts(db, orgId, { size: SITE_BLOG_PAGE_SIZE, cursorId: cursor });
    return { posts: posts.filter((p) => p.slug).map(toCard), olderCursor: nextCursor, cursor };
}

/** One published post by its address, with its pictures given fresh links; null when there is none. */
export async function loadSiteBlogPost(db: Db, orgId: number, slug: string, origin: string, origins: string[] = []): Promise<SiteBlogPost | null> {
    const [post] = await db.select({
        title: blogPosts.title, slug: blogPosts.slug, publishedPayload: blogPosts.publishedPayload,
        metaTitle: blogPosts.metaTitle, metaDescription: blogPosts.metaDescription, robots: blogPosts.robots,
        tags: blogPosts.tags, canonicalUrl: blogPosts.canonicalUrl, publishedAt: blogPosts.publishedAt, updatedAt: blogPosts.updatedAt,
    }).from(blogPosts)
        .where(and(eq(blogPosts.organisationId, orgId), eq(blogPosts.slug, slug), eq(blogPosts.status, 'published')))
        .limit(1);
    if (!post || !post.slug) return null;
    const payload = (post.publishedPayload as Record<string, any> | null) || null;
    const raw = payload && typeof payload.html === 'string' ? payload.html : '';
    const bodyHtml = raw ? await resolveInlineMedia(db, orgId, raw) : '';
    const imageUrl = await resolveFeatureImageUrl(db, orgId, payload?.featureImage?.assetId);
    return {
        title: post.title || post.metaTitle || 'Blog post',
        slug: post.slug,
        metaTitle: post.metaTitle,
        description: post.metaDescription || await excerpt(raw, 200) || '',
        bodyHtml,
        imageUrl,
        imageAlt: (payload?.featureImage?.alt as string | undefined) || post.title || '',
        tags: Array.isArray(post.tags) ? (post.tags as unknown[]).map(String).filter(Boolean) : [],
        publishedAt: iso(post.publishedAt),
        modifiedAt: iso(post.updatedAt),
        canonicalUrl: siteBlogCanonical(post.canonicalUrl, post.slug, origin, origins),
        robots: post.robots || 'index,follow',
    };
}

/**
 * The posts that belong in this site's sitemap (newest first, capped): indexable, and canonical HERE —
 * a post whose canonical is another site is that site's to list.
 */
export async function siteBlogSlugs(db: Db, orgId: number, origin: string, origins: string[] = [], limit = 500): Promise<Array<{ slug: string; lastmod: string | null }>> {
    const rows = await db.select({ slug: blogPosts.slug, updatedAt: blogPosts.updatedAt, robots: blogPosts.robots, canonicalUrl: blogPosts.canonicalUrl }).from(blogPosts)
        .where(and(eq(blogPosts.organisationId, orgId), eq(blogPosts.status, 'published')))
        .orderBy(sql`COALESCE(${blogPosts.publishedAt}, ${blogPosts.createdAt}) DESC`)
        .limit(limit);
    return rows
        .filter((r) => r.slug && !/noindex/i.test(String(r.robots || '')))
        .filter((r) => canonicalIsHere(siteBlogCanonical(r.canonicalUrl, r.slug!, origin, origins), origin, origins))
        .map((r) => ({ slug: r.slug!, lastmod: iso(r.updatedAt) }));
}

const hostOf = (o: string) => { try { return new URL(o).host.replace(/^www\./, ''); } catch { return ''; } };
function canonicalIsHere(stamped: string | null, origin: string, origins: string[]): boolean {
    return !!stamped && [origin, ...origins].map(hostOf).includes(hostOf(stamped));
}

/** For the editor and the chat: how many posts the Blog Assistant has published. */
export async function siteBlogSummary(db: Db, orgId: number): Promise<{ published: number }> {
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(blogPosts)
        .where(and(eq(blogPosts.organisationId, orgId), eq(blogPosts.status, 'published')));
    return { published: Number(n) };
}

export async function siteBlogForPrompt(db: Db, orgId: number, def: SiteDefinition): Promise<string> {
    const { published } = await siteBlogSummary(db, orgId);
    const state = blogOn(def) ? `Their blog is ON: ${BLOG_PATH} lists the posts and is in the menu as "${def.settings.blog!.menuLabel}".` : 'Their blog is OFF on this site.';
    return `${state} The posts come ONLY from their Blog Assistant (${published} published so far) — you cannot write, change or remove a post here; that is done with the Blog Assistant. Switch the blog on or off, or rename its menu entry, with set_settings {"blog":{"enabled":true|false,"menuLabel":"…"}}. A blog_posts section shows the newest posts on any page.`;
}
