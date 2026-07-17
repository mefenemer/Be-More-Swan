// src/utils/blog-publish.ts
// Shared publish transition for a blog post (US 3.1 + US 6.1), used by BOTH the interactive
// publish-blog handler and the scheduled publish-blog-posts cron (US 4.1). Renders the immutable
// published_payload snapshot, resolves a unique-per-org slug, snapshots the hero graphic as a
// stable assetId, stamps content_provenance, and flips the post to 'published'.
//
// The caller has already loaded the post row and confirmed it belongs to `organisationId`.

import { createHash, createHmac, randomUUID } from 'crypto';
import { and, eq, ne } from 'drizzle-orm';
import { marked } from 'marked';
import { blogPosts, contentAssets, contentProvenance } from '../../db/schema';
import { renderMarkdown, excerpt } from './markdown-render';
import { isC2paSigningEnabled, signStoredImageAsset, type ManifestSummary } from './c2pa-sign';
import { stripMediaForSyndication as stripMedia } from '../lib/marked-bms-directives.js';

const jwtSecret = process.env.JWT_SECRET || 'fallback';
const C2PA_SCHEMA_VERSION = '1.0';

const pseudonymiseOrg = (orgId: number) =>
    createHmac('sha256', jwtSecret).update(`org:${orgId}`).digest('hex').slice(0, 16);
const hashModel = (model: string) => createHash('sha256').update(model).digest('hex').slice(0, 32);

export function slugifyTitle(input: string): string {
    return String(input || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'post';
}

type BlogPostRow = typeof blogPosts.$inferSelect;

/**
 * Project a blog body for an EXTERNAL destination (Dev.to / Hashnode): text only, no media.
 * See docs/blog-media-composition-plan.md §3.5 (decided).
 *
 * Why no media at all:
 *   · Our own URLs are presigned and expiring, so anything we hand an external platform 404s later.
 *     publish-blog-destinations already refuses to syndicate the hero for exactly this reason
 *     (`coverImageUrl: null`) — this extends that existing decision to body media.
 *   · Pexels is hotlink-only under its ToS (src/utils/pexels.ts), so re-hosting stock media on
 *     Dev.to's CDN would breach the licence.
 *
 * This also closes a live bug: bodyMarkdown was previously syndicated RAW, so an inline image
 * shipped to Dev.to as the literal, unresolvable text `![alt](asset://42)` (plan §2.4).
 *
 * Columns are UNWRAPPED rather than dropped — a column holds the author's prose as well as their
 * media, and dropping the container would silently delete their words.
 */
export function stripMediaForSyndication(bodyMarkdown: string): string {
    return stripMedia(marked, bodyMarkdown);
}

// Publishes `post` and returns the updated row. Assumes post.bodyMarkdown is non-empty (callers check).
export async function publishBlogPost(db: any, post: BlogPostRow, organisationId: number): Promise<BlogPostRow> {
    const id = post.id;

    // Resolve a unique-per-org slug (partial unique index enforces it; disambiguate on collision).
    let slug = post.slug || slugifyTitle(post.title);
    const [clash] = await db
        .select({ id: blogPosts.id })
        .from(blogPosts)
        .where(and(eq(blogPosts.organisationId, organisationId), eq(blogPosts.slug, slug), ne(blogPosts.id, id)))
        .limit(1);
    if (clash) slug = `${slug}-${id}`;

    // Snapshot the hero/feature graphic as a STABLE reference (assetId, not a URL): presigned R2
    // URLs expire, so widget-api resolves a fresh URL from this assetId at read time (US 2.1).
    let featureImage: { assetId: number; alt: string; attribution: string | null } | null = null;
    if (post.featureAssetId) {
        const [asset] = await db
            .select({ id: contentAssets.id, name: contentAssets.name, attributionName: contentAssets.attributionName })
            .from(contentAssets)
            .where(and(eq(contentAssets.id, post.featureAssetId), eq(contentAssets.organisationId, organisationId)))
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

    // US 6.1 — C2PA image-byte signing. OFF by default: isC2paSigningEnabled() is false until a
    // signing cert is provisioned, so this block is inert in production today. When enabled, embed a
    // signed manifest into the feature image bytes (in place) and stamp the summary onto provenance.
    let imageManifest: ManifestSummary | null = null;
    if (featureImage && isC2paSigningEnabled()) {
        imageManifest = await signStoredImageAsset(db, {
            assetId: featureImage.assetId,
            organisationId,
            claims: {
                title: post.title,
                aiGenerated: aiAssisted,
                modelHint: aiAssisted ? 'ai-generated' : 'human-authored',
                contentId,
                authorLabel: post.ownerLabel ?? undefined,
            },
        });
    }
    const imageProvenance = imageManifest
        ? { imageManifest, imageSigner: imageManifest.signer, imageSignedAt: new Date(imageManifest.signedAt) }
        : {};

    if (post.provenanceContentId) {
        await db.update(contentProvenance)
            .set({ publishedAt: now, hitlReviewed: true, hitlReviewedAt: now, ...imageProvenance })
            .where(eq(contentProvenance.contentId, contentId));
    } else {
        await db.insert(contentProvenance).values({
            contentId,
            assistantId: post.assistantId ?? null,
            organisationId,
            workspaceIdHash: pseudonymiseOrg(organisationId),
            modelUsedHash: hashModel(aiAssisted ? 'ai-generated' : 'human-authored'),
            hitlReviewed: true,
            hitlReviewedAt: now,
            publishedAt: now,
            c2paSchemaVersion: C2PA_SCHEMA_VERSION,
            ...imageProvenance,
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
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, organisationId)))
        .returning();

    return updated;
}

// Retracts the NATIVE copy of `post` and returns the updated row: widget-api serves only
// status='published', so flipping back to 'draft' takes it off the org's site immediately.
// The caller has already loaded the row, org-scoped it, and confirmed status === 'published'.
//
// Deliberately non-destructive, so unpublish → republish is lossless and permalink-stable:
//   · slug + publishedPayload stay put — republishing reuses the same URL and snapshot.
//   · publishedAt stays — publishBlogPost's `post.publishedAt || now` then keeps the ORIGINAL
//     publication date on republish rather than back-dating the post to the retraction.
//   · content_provenance is left untouched — it attests what WAS published at a point in time,
//     and retracting the post doesn't unmake that history.
//
// Syndicated copies are NOT retracted: the adapter interface has no unpublish (see
// blog-destinations/types.ts), so external targets keep their own status in `destinations` and the
// caller is responsible for telling the user they're still live.
export async function unpublishBlogPost(db: any, post: BlogPostRow, organisationId: number): Promise<BlogPostRow> {
    const destinations = { ...(post.destinations as Record<string, unknown> || {}), widget: 'unpublished' };

    const [updated] = await db
        .update(blogPosts)
        .set({ status: 'draft', destinations, updatedAt: new Date() })
        .where(and(eq(blogPosts.id, post.id), eq(blogPosts.organisationId, organisationId)))
        .returning();

    return updated;
}
