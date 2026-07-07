// netlify/functions/publish-blog.ts
// Autonomous Content Engine — publish transition (US 3.1 + US 6.1).
//
// Renders body_markdown into the immutable, sanitised published_payload snapshot the widget serves,
// flips the post to 'published', assigns a slug, marks the widget destination live, and stamps a
// content_provenance row (C2PA metadata; image-byte signing is a separate US 6.1 follow-up).
//
// POST { id }  →  { post }
//
// NOTE: the modelUsedHash placeholder ('ai-generated' | 'human-authored') is refined once the
// generation-model is plumbed through blog_posts (see docs §12 / US 6.1). Hash helpers mirror
// netlify/functions/content-provenance.ts (the canonical implementation).

import { HandlerEvent } from '@netlify/functions';
import { createHash, createHmac, randomUUID } from 'crypto';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts, contentAssets, contentProvenance } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { renderMarkdown, excerpt } from '../../src/utils/markdown-render';

const jwtSecret = process.env.JWT_SECRET || 'fallback';
const C2PA_SCHEMA_VERSION = '1.0';

const pseudonymiseOrg = (orgId: number) =>
    createHmac('sha256', jwtSecret).update(`org:${orgId}`).digest('hex').slice(0, 16);
const hashModel = (model: string) => createHash('sha256').update(model).digest('hex').slice(0, 32);

function slugify(input: string): string {
    return String(input || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'post';
}

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: any;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
    }
    const id = Number(body.id);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    const [post] = await db
        .select()
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };
    if (!post.bodyMarkdown || !post.bodyMarkdown.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Cannot publish an empty post.' }) };
    }

    // Resolve a unique-per-org slug (partial unique index enforces it; disambiguate on collision).
    let slug = post.slug || slugify(post.title);
    const [clash] = await db
        .select({ id: blogPosts.id })
        .from(blogPosts)
        .where(and(eq(blogPosts.organisationId, ctx.organisationId), eq(blogPosts.slug, slug), ne(blogPosts.id, id)))
        .limit(1);
    if (clash) slug = `${slug}-${id}`;

    // Snapshot the hero/feature graphic as a STABLE reference (assetId, not a URL): presigned R2
    // URLs expire, so widget-api resolves a fresh URL from this assetId at read time (US 2.1).
    let featureImage: { assetId: number; alt: string; attribution: string | null } | null = null;
    if (post.featureAssetId) {
        const [asset] = await db
            .select({ id: contentAssets.id, name: contentAssets.name, attributionName: contentAssets.attributionName })
            .from(contentAssets)
            .where(and(eq(contentAssets.id, post.featureAssetId), eq(contentAssets.organisationId, ctx.organisationId)))
            .limit(1);
        if (asset) featureImage = { assetId: asset.id, alt: asset.name || post.title, attribution: asset.attributionName };
    }

    // Render the immutable, embed-safe snapshot.
    const html = renderMarkdown(post.bodyMarkdown);
    const publishedPayload = {
        html,
        title: post.metaTitle || post.title,
        description: post.metaDescription || excerpt(post.bodyMarkdown, 200),
        tags: post.tags,
        featureImage,
        renderedAt: new Date().toISOString(),
    };

    // Stamp provenance (create on first publish, refresh publishedAt on re-publish).
    const aiAssisted = !!(post.jobId || post.blueprintId || post.isAutonomous);
    const contentId = post.provenanceContentId || randomUUID();
    const now = new Date();
    if (post.provenanceContentId) {
        await db.update(contentProvenance)
            .set({ publishedAt: now, hitlReviewed: true, hitlReviewedAt: now })
            .where(eq(contentProvenance.contentId, contentId));
    } else {
        await db.insert(contentProvenance).values({
            contentId,
            assistantId: post.assistantId ?? null,
            organisationId: ctx.organisationId,
            workspaceIdHash: pseudonymiseOrg(ctx.organisationId),
            modelUsedHash: hashModel(aiAssisted ? 'ai-generated' : 'human-authored'),
            hitlReviewed: true,
            hitlReviewedAt: now,
            publishedAt: now,
            c2paSchemaVersion: C2PA_SCHEMA_VERSION,
        });
    }

    const destinations = { ...(post.destinations as Record<string, unknown> || {}), widget: 'published' };

    const [updated] = await db
        .update(blogPosts)
        .set({
            status: 'published',
            slug,
            publishedPayload,
            provenanceContentId: contentId,
            publishedAt: post.publishedAt || now,
            destinations,
            updatedAt: now,
        })
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, ctx.organisationId)))
        .returning();

    return { statusCode: 200, body: JSON.stringify({ post: updated }) };
};
