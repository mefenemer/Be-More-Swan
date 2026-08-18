// netlify/functions/widget-rss.ts
// Autonomous Content Engine — US 3.2 (docs/content-engine-remaining-build.md §A.4): a per-widget RSS
// 2.0 feed of a workspace's published blog.
//
// Behind a netlify.toml rewrite, which MUST precede the /api/widget/* catch-all (first-match-wins —
// otherwise widget-api.ts parses resource="rss" and 404s, the same trap as /b/:key/sitemap.xml):
//   GET /api/widget/:key/rss  → <rss><channel> of that org's published posts
//
// This is the universal fallback for every platform NOT on the four-connector list (§A): anything
// that can read a feed — Medium, Substack, Mailchimp, Zapier, an aggregator, a reader — can pull the
// blog without us writing an adapter for it.
//
// No auth, keyed by the unguessable widget_configs.public_key that resolves to exactly one
// organisation, and only that org's PUBLISHED posts are ever serialised — same isolation rules as
// widget-api.ts, no id enumeration.
//
// ── Why this reuses the syndication projection ────────────────────────────────────────────────
// A feed is a syndication destination without an adapter: third-party surfaces store our text
// indefinitely and re-render it on their own domain. That is exactly the population projectPost()
// already serves, so it governs here too rather than being re-derived:
//   · media is STRIPPED (docs/blog-media-composition-plan.md §3.5) — our asset:// refs are
//     unresolvable off-site, presigned R2 URLs expire in 600s, and Pexels is hotlink-only, so a feed
//     carrying media would ship dead images and a licence breach into readers that cache forever;
//   · the AI transparency notice (EU AI Act Art. 50) is appended to the body, honouring the
//     workspace's badge_enabled preference, so the same post is not labelled on our widget and
//     unlabelled in someone's feed reader.
// Change the disclosure wording or the stripping rules once and the feed follows.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs, blogPosts } from '../../db/schema';
import { projectPost } from '../../src/utils/blog-destinations/syndicate';
import { buildRssFeed, emptyRssFeed, feedGuid, type RssItemInput } from '../../src/utils/blog-rss';
import { resolveCanonical } from '../../src/utils/blog-seo';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

// Feed readers poll on their own schedule (typically 15–60 min), so a long shared cache costs
// freshness nobody perceives and spares the DB a query per subscriber per poll. Matches the
// sitemap's window rather than widget-api's shorter one — a feed is not read interactively.
const CACHE = 'public, max-age=300, s-maxage=1800';

// CORS-open like widget-api.ts: browser-based readers and the customer's own site may fetch this
// cross-origin. Nothing here is not already public on the widget.
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

/** How many entries a feed carries. 20 is the conventional length; it also bounds the per-request
 *  Markdown renders, since projectPost() renders each entry's body. */
const FEED_LIMIT = 20;

function xml(statusCode: number, body: string, cache = false) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/rss+xml; charset=utf-8',
            ...CORS,
            ...(cache ? { 'Cache-Control': CACHE } : {}),
        },
        body,
    };
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    // Parse the ORIGINAL (pre-rewrite) path — the rewrite is a 200, so it survives in rawUrl.
    const path = event.rawUrl ? new URL(event.rawUrl).pathname : event.path || '';
    const m = path.match(/\/api\/widget\/([^/]+)\/rss/);
    if (!m) return xml(400, emptyRssFeed());
    const publicKey = m[1];

    const db = getDb();
    const [cfg] = await db
        .select({
            organisationId: widgetConfigs.organisationId,
            name: widgetConfigs.name,
            status: widgetConfigs.status,
            badgeEnabled: widgetConfigs.badgeEnabled,
            siteBaseUrl: widgetConfigs.siteBaseUrl,
            sitePostPath: widgetConfigs.sitePostPath,
        })
        .from(widgetConfigs)
        .where(eq(widgetConfigs.publicKey, publicKey))
        .limit(1);
    if (!cfg || cfg.status !== 'active') return xml(404, emptyRssFeed());

    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);

    const rows = await db
        .select({
            id: blogPosts.id,
            title: blogPosts.title,
            slug: blogPosts.slug,
            bodyMarkdown: blogPosts.bodyMarkdown,
            metaDescription: blogPosts.metaDescription,
            canonicalUrl: blogPosts.canonicalUrl,
            tags: blogPosts.tags,
            robots: blogPosts.robots,
            publishedAt: blogPosts.publishedAt,
            jobId: blogPosts.jobId,
            blueprintId: blogPosts.blueprintId,
            isAutonomous: blogPosts.isAutonomous,
            generationReason: blogPosts.generationReason,
        })
        .from(blogPosts)
        .where(and(eq(blogPosts.organisationId, cfg.organisationId), eq(blogPosts.status, 'published')))
        .orderBy(desc(blogPosts.publishedAt))
        .limit(FEED_LIMIT);

    const items: RssItemInput[] = [];
    let latest: Date | null = null;

    for (const p of rows) {
        if (!p.slug) continue;
        // An author who set noindex asked not to be surfaced beyond their own page. Aggregators
        // republish feed entries as indexable pages, so honouring it here matches blog-sitemap.ts
        // rather than quietly routing around the same instruction.
        if (p.robots && p.robots.startsWith('noindex')) continue;

        // Same resolver, same precedence as the canonical stamp and the sitemap, so the three can
        // never disagree about where a post lives. Posts published before the canonical-write fix
        // have a NULL column and fall through to the resolver.
        const link = p.canonicalUrl || resolveCanonical({
            slug: p.slug, siteBaseUrl: cfg.siteBaseUrl, sitePostPath: cfg.sitePostPath, publicKey, baseUrl,
        });
        if (!link) continue; // no canonical and no baseUrl to build one → nothing to point a reader at

        const projected = await projectPost(p, { badgeEnabled: cfg.badgeEnabled });
        if (!projected) continue; // media-only post: nothing left once media is stripped

        const publishedAt = p.publishedAt ? new Date(p.publishedAt) : null;
        if (publishedAt && (!latest || publishedAt > latest)) latest = publishedAt;

        items.push({
            title: projected.title,
            link,
            guid: feedGuid(publicKey, p.slug),
            publishedAt,
            description: projected.metaDescription,
            contentHtml: projected.bodyHtml,
            tags: projected.tags || [],
        });
    }

    // RSS 2.0 requires a channel <link> to the human-readable site. We know it only when the customer
    // has told us where they publish; otherwise point at our own permalink root for this widget.
    const channelLink = cfg.siteBaseUrl?.replace(/\/+$/, '')
        || (baseUrl ? `${baseUrl}/b/${encodeURIComponent(publicKey)}/` : '');

    return xml(200, buildRssFeed({
        title: cfg.name,
        link: channelLink,
        description: `Latest posts from ${cfg.name}.`,
        selfUrl: baseUrl ? `${baseUrl}/api/widget/${encodeURIComponent(publicKey)}/rss` : null,
        lastBuildDate: latest,
    }, items), true);
});
