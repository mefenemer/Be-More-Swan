// netlify/functions/blog-sitemap.ts
// Autonomous Content Engine — US 1.3: a per-widget XML sitemap for a workspace's published blog.
//
// Behind a netlify.toml rewrite (which MUST precede the /b/* catch-all):
//   GET /b/:key/sitemap.xml  → <urlset> of that org's published posts, each at its canonical URL.
//
// One sitemap per widget public_key, not a single cross-tenant file — a customer submits their own
// `/b/<key>/sitemap.xml` to Search Console (and it pairs with the existing GSC decay ingest, US 5.1).
// We list the CANONICAL url of each post (Google's sitemap guidance): the customer's own domain when
// they've configured site_base_url + site_post_path, else our /b/:key/:slug permalink. Both come from
// the same resolver used at publish time, so the sitemap can never disagree with <link rel=canonical>.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs, blogPosts } from '../../db/schema';
import { resolveCanonical } from '../../src/utils/blog-seo';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

const CACHE = 'public, max-age=300, s-maxage=1800';

// Escape a URL for XML text content (& first, then the angle/quote set).
function escXml(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xml(statusCode: number, body: string, cache = false) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', ...(cache ? { 'Cache-Control': CACHE } : {}) },
        body,
    };
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const path = event.rawUrl ? new URL(event.rawUrl).pathname : event.path || '';
    const m = path.match(/\/b\/([^/]+)\/sitemap\.xml/);
    if (!m) return xml(400, '<?xml version="1.0" encoding="UTF-8"?><error>Malformed sitemap route.</error>');
    const publicKey = m[1];

    const db = getDb();
    const [cfg] = await db
        .select({
            organisationId: widgetConfigs.organisationId,
            status: widgetConfigs.status,
            siteBaseUrl: widgetConfigs.siteBaseUrl,
            sitePostPath: widgetConfigs.sitePostPath,
        })
        .from(widgetConfigs)
        .where(eq(widgetConfigs.publicKey, publicKey))
        .limit(1);
    // 404 with a well-formed empty urlset so a bad key isn't crawled as broken content.
    if (!cfg || cfg.status !== 'active') {
        return xml(404, '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
    }

    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);

    const posts = await db
        .select({
            slug: blogPosts.slug,
            canonicalUrl: blogPosts.canonicalUrl,
            robots: blogPosts.robots,
            publishedAt: blogPosts.publishedAt,
            updatedAt: blogPosts.updatedAt,
        })
        .from(blogPosts)
        .where(and(eq(blogPosts.organisationId, cfg.organisationId), eq(blogPosts.status, 'published')))
        .orderBy(desc(blogPosts.publishedAt))
        .limit(5000); // sitemap protocol caps a single file at 50k URLs / 50MB — well clear.

    const entries: string[] = [];
    for (const p of posts) {
        if (!p.slug) continue;
        // Don't advertise a post the author has told crawlers not to index.
        if (p.robots && p.robots.startsWith('noindex')) continue;
        const loc = p.canonicalUrl || resolveCanonical({
            slug: p.slug, siteBaseUrl: cfg.siteBaseUrl, sitePostPath: cfg.sitePostPath, publicKey, baseUrl,
        });
        if (!loc) continue; // no canonical and no baseUrl to self-canonicalise → nothing to list.
        const lastmod = (p.updatedAt || p.publishedAt) as Date | null;
        entries.push(
            '  <url>\n' +
            `    <loc>${escXml(loc)}</loc>\n` +
            (lastmod ? `    <lastmod>${new Date(lastmod).toISOString()}</lastmod>\n` : '') +
            '  </url>',
        );
    }

    const body = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        entries.join('\n') + (entries.length ? '\n' : '') +
        '</urlset>';
    return xml(200, body, true);
});
