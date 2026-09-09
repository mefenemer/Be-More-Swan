// netlify/functions/widget-api.ts
// Autonomous Content Engine — US 3.1: public, read-only API powering the embeddable BMS widget.
//
// No auth. Keyed by an unguessable widget_configs.public_key that resolves to one organisation;
// only that org's PUBLISHED blog_posts are ever returned (tenant isolation, no id enumeration).
// Serves the immutable published_payload snapshot so responses stay CDN-cacheable. CORS-open
// because the widget is embedded on third-party customer sites. See docs §8.
//
// Behind a netlify.toml rewrite:  /api/widget/*  →  /.netlify/functions/widget-api
//   GET /api/widget/:key/config          → { theme, badgeEnabled, name }
//   GET /api/widget/:key/posts[?limit=&cursor=]  → { posts: [summary + author/tags/date], nextCursor }
//   GET /api/widget/:key/posts/:slug     → { post: {...payload, aiAssisted, hookVariants, abState} }

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs, blogPosts, organisations } from '../../db/schema';
import {
    resolveInlineMedia, resolveFeatureImageUrl, resolveCardImageUrls,
} from '../../src/utils/blog-media-resolve';
import { cardImageRef } from '../../src/utils/blog-card-image';
import { isAiAssisted } from '../../src/utils/blog-ai-assisted';
import {
    listSortKey, afterCursor, pageSize, parseCursor, takePage,
} from '../../src/utils/blog-list-paging';
import { withLambda } from '@netlify/aws-lambda-compat';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
const CACHE = 'public, max-age=120, s-maxage=300';

function json(statusCode: number, obj: unknown, cache = false) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json', ...CORS, ...(cache ? { 'Cache-Control': CACHE } : {}) },
        body: JSON.stringify(obj),
    };
}

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    // Parse /api/widget/:key/:resource[/:slug] from the original (pre-rewrite) path.
    const path = (event.rawUrl ? new URL(event.rawUrl).pathname : event.path || '');
    const m = path.match(/\/api\/widget\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
    if (!m) return json(400, { error: 'Malformed widget route.' });
    const [, publicKey, resource, slug] = m;

    const db = getDb();
    const [cfg] = await db
        .select({
            organisationId: widgetConfigs.organisationId,
            name: widgetConfigs.name,
            theme: widgetConfigs.theme,
            badgeEnabled: widgetConfigs.badgeEnabled,
            status: widgetConfigs.status,
            // The BYLINE for every card in the list — the organisation, e.g. "Be More Swan".
            // ⚠️ NOT widgetConfigs.name, which sits right above it and is the widget's own label
            // ("Default" out of the box). Joined into the lookup that already runs on every
            // request rather than fetched separately, so the byline costs nothing extra.
            orgName: organisations.name,
        })
        .from(widgetConfigs)
        .leftJoin(organisations, eq(organisations.id, widgetConfigs.organisationId))
        .where(eq(widgetConfigs.publicKey, publicKey))
        .limit(1);
    if (!cfg || cfg.status !== 'active') return json(404, { error: 'Widget not found.' });

    const orgId = cfg.organisationId;

    if (resource === 'config') {
        return json(200, { name: cfg.name, theme: cfg.theme, badgeEnabled: cfg.badgeEnabled }, true);
    }

    if (resource === 'posts' && !slug) {
        const qs = event.queryStringParameters || {};
        const size = pageSize(qs.limit);
        const cursorId = parseCursor(qs.cursor);

        const rows = await db
            .select({
                // Selected for the cursor, not for the response — the id stays server-side, and
                // nextCursor is the only form of it a caller ever sees.
                id: blogPosts.id,
                title: blogPosts.title,
                slug: blogPosts.slug,
                metaDescription: blogPosts.metaDescription,
                tags: blogPosts.tags,
                publishedAt: blogPosts.publishedAt,
                jobId: blogPosts.jobId,
                blueprintId: blogPosts.blueprintId,
                isAutonomous: blogPosts.isAutonomous,
                generationReason: blogPosts.generationReason,
                // The list thumbnail, denormalised at publish time. Three small columns instead of
                // published_payload — pulling 50 full article bodies to find 50 <img> tags is the
                // reason this is a column and not a read-time parse.
                cardImageAssetId: blogPosts.cardImageAssetId,
                cardImageUrl: blogPosts.cardImageUrl,
                cardImageAlt: blogPosts.cardImageAlt,
            })
            .from(blogPosts)
            .where(and(
                eq(blogPosts.organisationId, orgId),
                eq(blogPosts.status, 'published'),
                ...(cursorId ? [afterCursor(cursorId, orgId)] : []),
            ))
            // id DESC is not decoration: two posts published in the same second would otherwise
            // come back in whatever order the planner chose, and a keyset cursor built on an
            // ambiguous order skips or repeats rows at exactly that boundary.
            .orderBy(desc(listSortKey), desc(blogPosts.id))
            // One more than asked for, purely to answer "is there another page?" without a
            // second COUNT query over the whole table.
            .limit(size + 1);

        const { page, nextCursor } = takePage(rows, size);
        // One batched query for the whole page's images, not one per post. Every row here belongs
        // to the same org — this endpoint is keyed by a single widget — but the resolver is
        // org-scoped per item regardless, so an asset id pointing outside the org resolves to null
        // rather than to somebody else's picture.
        const imageUrls = await resolveCardImageUrls(db, page.map((r) => ({ orgId, ref: cardImageRef(r) })));
        const posts = page.map((r, i) => ({
            title: r.title,
            slug: r.slug,
            excerpt: r.metaDescription || '',
            tags: r.tags,
            publishedAt: r.publishedAt,
            aiAssisted: isAiAssisted(r),
            // null when the post has no usable image. The widget then renders a text-only card,
            // which is the right look for an essay — not a gap where a picture failed to load.
            imageUrl: imageUrls[i],
            imageAlt: r.cardImageAlt || r.title,
            // The byline. Already selected above with the config, so it costs no extra query —
            // and it is the same string blog-page.ts prints on the post itself, so the card and
            // the page it opens cannot disagree about who published it.
            author: cfg.orgName || null,
        }));
        return json(200, { posts, nextCursor }, true);
    }

    if (resource === 'posts' && slug) {
        const [post] = await db
            .select({
                title: blogPosts.title,
                slug: blogPosts.slug,
                publishedPayload: blogPosts.publishedPayload,
                metaTitle: blogPosts.metaTitle,
                metaDescription: blogPosts.metaDescription,
                tags: blogPosts.tags,
                publishedAt: blogPosts.publishedAt,
                hookVariants: blogPosts.hookVariants,
                winningVariant: blogPosts.winningVariant,
                abState: blogPosts.abState,
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
        if (!post) return json(404, { error: 'Post not found.' });

        // Resolve a fresh feature-image URL from the snapshotted assetId (presigned R2 URLs expire,
        // so we never store one in the immutable payload). A deleted asset degrades to no image.
        const payload = (post.publishedPayload as Record<string, any> | null) || null;
        const featureAssetId = payload?.featureImage?.assetId;
        if (payload && Number.isFinite(featureAssetId)) {
            payload.featureImage = { ...payload.featureImage, url: await resolveFeatureImageUrl(db, orgId, featureAssetId) };
        }

        // Resolve fresh URLs for any inline media referenced in the snapshotted body HTML.
        if (payload && typeof payload.html === 'string') {
            payload.html = await resolveInlineMedia(db, orgId, payload.html);
        }

        return json(200, {
            post: {
                title: post.title,
                slug: post.slug,
                payload,
                metaTitle: post.metaTitle,
                metaDescription: post.metaDescription,
                tags: post.tags,
                publishedAt: post.publishedAt,
                hookVariants: post.hookVariants,
                winningVariant: post.winningVariant,
                abState: post.abState,
                aiAssisted: isAiAssisted(post),
                badgeEnabled: cfg.badgeEnabled,
            },
        }, true);
    }

    return json(404, { error: 'Unknown widget resource.' });
});
