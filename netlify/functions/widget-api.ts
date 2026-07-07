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
//   GET /api/widget/:key/posts           → { posts: [summary] }
//   GET /api/widget/:key/posts/:slug     → { post: {...payload, aiAssisted, hookVariants, abState} }

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { widgetConfigs, blogPosts, contentAssets } from '../../db/schema';
import { resolveAssetDisplayUrl } from '../../src/utils/social-publish';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
const CACHE = 'public, max-age=120, s-maxage=300';

// Escape a resolved URL for safe insertion into an HTML double-quoted attribute value.
function escAttr(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline media is snapshotted as src-less <img data-bms-asset="N"> (markdown-render). Resolve each
// referenced asset to a fresh, org-scoped URL and inject it as the img src. A deleted/foreign asset
// is left without a src (graceful degrade). Mirrors the feature-image read-time resolution, and is
// safe to cache because widget-api's TTL (s-maxage=300) is under the presigned-URL lifetime (600s).
async function resolveInlineMedia(db: ReturnType<typeof getDb>, orgId: number, html: string): Promise<string> {
    if (!html || !html.includes('data-bms-asset')) return html;
    const ids = [...new Set([...html.matchAll(/data-bms-asset="(\d+)"/g)].map((x) => Number(x[1])))]
        .filter(Number.isFinite);
    if (!ids.length) return html;

    const assets = await db
        .select({
            id: contentAssets.id, assetType: contentAssets.assetType, storageUrl: contentAssets.storageUrl,
            storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
        })
        .from(contentAssets)
        .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));

    const urlById = new Map<number, string | null>();
    for (const a of assets) urlById.set(a.id, await resolveAssetDisplayUrl(a));

    return html.replace(/<img([^>]*?)data-bms-asset="(\d+)"([^>]*)>/g, (full, pre, id, post) => {
        const url = urlById.get(Number(id));
        return url ? `<img src="${escAttr(url)}"${pre}data-bms-asset="${id}"${post}>` : full;
    });
}

function json(statusCode: number, obj: unknown, cache = false) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json', ...CORS, ...(cache ? { 'Cache-Control': CACHE } : {}) },
        body: JSON.stringify(obj),
    };
}

export const handler = async (event: HandlerEvent) => {
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
        })
        .from(widgetConfigs)
        .where(eq(widgetConfigs.publicKey, publicKey))
        .limit(1);
    if (!cfg || cfg.status !== 'active') return json(404, { error: 'Widget not found.' });

    const orgId = cfg.organisationId;

    if (resource === 'config') {
        return json(200, { name: cfg.name, theme: cfg.theme, badgeEnabled: cfg.badgeEnabled }, true);
    }

    if (resource === 'posts' && !slug) {
        const rows = await db
            .select({
                title: blogPosts.title,
                slug: blogPosts.slug,
                metaDescription: blogPosts.metaDescription,
                tags: blogPosts.tags,
                publishedAt: blogPosts.publishedAt,
                provenanceContentId: blogPosts.provenanceContentId,
            })
            .from(blogPosts)
            .where(and(eq(blogPosts.organisationId, orgId), eq(blogPosts.status, 'published')))
            .orderBy(desc(blogPosts.publishedAt))
            .limit(50);
        const posts = rows.map((r) => ({
            title: r.title,
            slug: r.slug,
            excerpt: r.metaDescription || '',
            tags: r.tags,
            publishedAt: r.publishedAt,
            aiAssisted: !!r.provenanceContentId,
        }));
        return json(200, { posts }, true);
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
                provenanceContentId: blogPosts.provenanceContentId,
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
            const [a] = await db
                .select({
                    assetType: contentAssets.assetType, storageUrl: contentAssets.storageUrl,
                    storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
                })
                .from(contentAssets)
                .where(and(eq(contentAssets.id, featureAssetId), eq(contentAssets.organisationId, orgId)))
                .limit(1);
            payload.featureImage = { ...payload.featureImage, url: a ? await resolveAssetDisplayUrl(a) : null };
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
                aiAssisted: !!post.provenanceContentId,
                badgeEnabled: cfg.badgeEnabled,
            },
        }, true);
    }

    return json(404, { error: 'Unknown widget resource.' });
};
