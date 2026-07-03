// scheduled-posts.ts — Content Calendar post CRUD + governance
//
// GET    ?from=ISO&to=ISO  → posts in date range for user's org
// GET    ?id=N              → single post detail
// POST                      → create draft post
// PATCH  ?id=N              → update status / caption / publishDate (reschedule)
// DELETE ?id=N              → cancel + soft-delete (status=cancelled)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, gte, lte } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, scheduledPosts, contentAssets, contentProvenance, userOrganisations } from '../../db/schema';
import { createHmac, createHash, randomUUID } from 'crypto';
import { propagateAssetStatuses } from './content-assets';
import { resolveAssetDisplayUrl } from '../../src/utils/social-publish';
import { requireOnboarding } from '../../src/utils/onboarding-guard';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';
import { resolveAssistantRole } from '../../src/utils/assistant-role';

const jwtSecret = process.env.JWT_SECRET;

const VALID_STATUSES = new Set(['draft', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'cancelled']);

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try { return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export const handler: Handler = async (event) => {
    const userId = getAuth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // US3 (AC3.1/AC3.2): the Content Calendar is gated until onboarding is complete.
    const denied = await requireOnboarding(db, userId);
    if (denied) return denied;

    const [user] = await db.select({ id: users.id, organisationId: userOrganisations.organisationId })
        .from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, userId));
    if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

    const qs = event.queryStringParameters || {};

    try {
        // ── GET ───────────────────────────────────────────────────
        if (event.httpMethod === 'GET') {
            // Single post detail
            if (qs.id) {
                const postId = parseInt(qs.id);
                const [post] = await db.select().from(scheduledPosts)
                    .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)));
                if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

                // Enrich with asset data if any
                const assetIds: number[] = Array.isArray(post.contentAssetIds) ? post.contentAssetIds as number[] : [];
                let assets: any[] = [];
                if (assetIds.length > 0) {
                    assets = await db.select({
                        id: contentAssets.id,
                        name: contentAssets.name,
                        assetType: contentAssets.assetType,
                        storageUrl: contentAssets.storageUrl,
                        storageKey: contentAssets.storageKey,
                        externalUrl: contentAssets.externalUrl,
                        mimeType: contentAssets.mimeType,
                    }).from(contentAssets)
                      .where(eq(contentAssets.userId, userId));
                    assets = assets.filter(a => assetIds.includes(a.id));
                    // Resolve a displayable URL for R2-stored assets (storageUrl is null
                    // until presigned) — otherwise the calendar panel shows "Media placeholder".
                    assets = await Promise.all(assets.map(async a => ({
                        ...a,
                        storageUrl: await resolveAssetDisplayUrl(a),
                    })));
                }

                return { statusCode: 200, body: JSON.stringify({ post, assets }) };
            }

            // Range query — default to current month if no params
            const from = qs.from ? new Date(qs.from) : (() => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; })();
            const to   = qs.to   ? new Date(qs.to)   : (() => { const d = new Date(); d.setMonth(d.getMonth()+1,0); d.setHours(23,59,59,999); return d; })();

            const posts = await db.select().from(scheduledPosts)
                .where(and(
                    eq(scheduledPosts.userId, userId),
                    gte(scheduledPosts.publishDate, from),
                    lte(scheduledPosts.publishDate, to),
                ));

            return { statusCode: 200, body: JSON.stringify({ posts }) };
        }

        // ── POST: create ──────────────────────────────────────────
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body || '{}');
            const {
                assistantId, platform, postFormat, publishDate,
                caption, contentAssetIds, linkUrl, ctaText, hashtags, mentions, utmParams,
                status, ownerLabel, isAutonomous, campaign, pillar,
            } = body;

            if (!platform || !postFormat || !publishDate) {
                return { statusCode: 400, body: JSON.stringify({ error: 'platform, postFormat, and publishDate are required.' }) };
            }

            // Runtime connection sandboxing: an assistant may only publish to platforms
            // relevant to its role (e.g. a non-social assistant cannot schedule posts).
            if (assistantId) {
                const assistant = await resolveAssistantRole(db, user.organisationId, parseInt(String(assistantId), 10));
                if (assistant && !isServiceAllowedForAssistant(platform, assistant)) {
                    return { statusCode: 403, body: JSON.stringify({ error: `This assistant is not permitted to publish to ${platform}.`, code: 'CONNECTION_NOT_RELEVANT' }) };
                }
            }

            const finalStatus = status || 'draft';
            const [created] = await db.insert(scheduledPosts).values({
                assistantId: assistantId || null,
                userId,
                organisationId: user.organisationId ?? null,
                platform,
                postFormat,
                publishDate: new Date(publishDate),
                caption: caption || null,
                contentAssetIds: contentAssetIds || [],
                linkUrl: linkUrl || null,
                ctaText: ctaText || null,
                hashtags: hashtags || null,
                mentions: mentions || null,
                utmParams: utmParams || null,
                status: finalStatus,
                ownerId: userId,
                ownerLabel: ownerLabel || null,
                isAutonomous: isAutonomous || false,
                campaign: campaign || null,
                pillar: pillar || null,
            }).returning();

            // ── Scenario 1: Propagate asset status on post creation ────────
            // If the post is created in a scheduled/approved state, move attached
            // pending assets to 'scheduled' so they appear in the right group.
            const createdAssetIds: number[] = Array.isArray(contentAssetIds) ? contentAssetIds : [];
            if (['scheduled', 'approved'].includes(finalStatus) && createdAssetIds.length > 0) {
                await propagateAssetStatuses(db, createdAssetIds, 'pending', 'scheduled');
            }

            return { statusCode: 201, body: JSON.stringify({ post: created }) };
        }

        // ── PATCH: update ─────────────────────────────────────────
        if (event.httpMethod === 'PATCH') {
            const postId = parseInt(qs.id || '');
            if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [existing] = await db.select().from(scheduledPosts)
                .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)));
            if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

            // Published posts are immutable
            if (existing.status === 'published') {
                return { statusCode: 409, body: JSON.stringify({ error: 'Published posts cannot be modified.' }) };
            }

            const body = JSON.parse(event.body || '{}');

            // ── Asset detachment (Scenario 1 & 2: Remove from Queue) ──────
            // PATCH ?id=N with { detachAssetId: number } removes the asset
            // reference from the post and reverts the asset's status to 'pending'.
            if (body.detachAssetId !== undefined) {
                const detachId = Number(body.detachAssetId);
                if (!Number.isFinite(detachId)) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid detachAssetId.' }) };
                }

                // Remove from contentAssetIds
                const currentIds: number[] = Array.isArray(existing.contentAssetIds) ? (existing.contentAssetIds as number[]) : [];
                if (!currentIds.includes(detachId)) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'Asset is not attached to this post.' }) };
                }
                const newIds = currentIds.filter(id => id !== detachId);

                // Platforms that require at least one media asset
                const MEDIA_REQUIRED_PLATFORMS = new Set(['instagram']);
                const mediaRequired = MEDIA_REQUIRED_PLATFORMS.has(existing.platform);
                const postUpdates: Record<string, any> = {
                    contentAssetIds: newIds,
                    updatedAt: new Date(),
                };

                // Scenario 2: If post can't exist without the asset, flag it
                let requiresAttention = false;
                if (mediaRequired && newIds.length === 0) {
                    postUpdates.status = 'draft';
                    requiresAttention = true;
                }

                const [updatedPost] = await db.update(scheduledPosts)
                    .set(postUpdates)
                    .where(eq(scheduledPosts.id, postId))
                    .returning();

                // Revert asset status to 'pending'
                await db.update(contentAssets)
                    .set({ status: 'pending', updatedAt: new Date() })
                    .where(and(
                        eq(contentAssets.id, detachId),
                        eq(contentAssets.userId, userId),
                    ));

                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        post: updatedPost,
                        requiresAttention,
                        message: requiresAttention
                            ? 'Post flagged as Draft — this platform requires at least one media asset.'
                            : 'Asset removed from post.',
                    }),
                };
            }

            const updates: Record<string, any> = { updatedAt: new Date() };

            const editableFields = ['caption', 'linkUrl', 'ctaText', 'hashtags', 'mentions', 'utmParams', 'campaign', 'pillar', 'postFormat', 'contentAssetIds'];
            editableFields.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });

            if (body.publishDate) {
                updates.publishDate = new Date(body.publishDate);
            }

            if (body.status) {
                if (!VALID_STATUSES.has(body.status)) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid status.' }) };
                }
                updates.status = body.status;
                if (body.status === 'rejected') {
                    updates.rejectedAt = new Date();
                    updates.rejectionReason = body.rejectionReason || null;
                }
                if (body.status === 'cancelled') {
                    updates.cancelledAt = new Date();
                }
                if (body.status === 'published') {
                    updates.publishedAt = new Date();
                    updates.platformPostUrl = body.platformPostUrl || null;
                    updates.platformPostId = body.platformPostId || null;
                    // US-GOV-3.2.1: attach C2PA provenance record on publish
                    const contentId = existing.provenanceContentId || randomUUID();
                    updates.provenanceContentId = contentId;
                    void (async () => {
                        try {
                            const [existingProv] = await db.select({ id: contentProvenance.id }).from(contentProvenance).where(eq(contentProvenance.contentId, contentId)).limit(1);
                            if (!existingProv) {
                                const modelHash = createHash('sha256').update('gpt-4o').digest('hex').slice(0, 32);
                                const orgHash = createHmac('sha256', process.env.JWT_SECRET || 'fallback').update(`org:${existing.organisationId}`).digest('hex').slice(0, 16);
                                await db.insert(contentProvenance).values({
                                    contentId,
                                    assistantId: existing.assistantId || null,
                                    organisationId: existing.organisationId || null,
                                    workspaceIdHash: orgHash,
                                    modelUsedHash: modelHash,
                                    hitlReviewed: existing.status === 'approved',
                                    hitlReviewedAt: existing.status === 'approved' ? new Date() : null,
                                    publishedAt: new Date(),
                                    c2paSchemaVersion: '1.0',
                                });
                            }
                        } catch { /* non-blocking */ }
                    })();
                }
            }

            // Include userId in WHERE clause to prevent IDOR — ownership already
            // verified by the findAssistant() check above, this is a defence-in-depth layer.
            const [updated] = await db.update(scheduledPosts).set(updates)
                .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId))).returning();

            // ── Scenarios 1 & 2: Propagate asset lifecycle on status change ─
            const linkedIds: number[] = Array.isArray(updated.contentAssetIds)
                ? (updated.contentAssetIds as number[])
                : [];
            const newStatus = updates.status as string | undefined;

            if (newStatus && linkedIds.length > 0) {
                if (['scheduled', 'approved'].includes(newStatus)) {
                    // Scenario 1: post queued → assets pending → scheduled
                    await propagateAssetStatuses(db, linkedIds, 'pending', 'scheduled');
                } else if (newStatus === 'published') {
                    // Scenario 2: post published → assets scheduled → posted
                    await propagateAssetStatuses(db, linkedIds, 'scheduled', 'posted');
                } else if (['cancelled', 'rejected'].includes(newStatus)) {
                    // Post abandoned → return scheduled assets to pending pool
                    await propagateAssetStatuses(db, linkedIds, 'scheduled', 'pending');
                }
            }

            // If contentAssetIds was patched (new assets added) and post is already scheduled,
            // promote any newly-added pending assets too.
            if (!newStatus && body.contentAssetIds && ['scheduled', 'approved'].includes(existing.status)) {
                const newIds: number[] = Array.isArray(body.contentAssetIds) ? body.contentAssetIds : [];
                const addedIds = newIds.filter(id => !(Array.isArray(existing.contentAssetIds) ? existing.contentAssetIds as number[] : []).includes(id));
                if (addedIds.length > 0) {
                    await propagateAssetStatuses(db, addedIds, 'pending', 'scheduled');
                }
            }

            return { statusCode: 200, body: JSON.stringify({ post: updated }) };
        }

        // ── DELETE: cancel/remove ─────────────────────────────────
        if (event.httpMethod === 'DELETE') {
            const postId = parseInt(qs.id || '');
            if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [existing] = await db.select().from(scheduledPosts)
                .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)));
            if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

            if (existing.status === 'published') {
                return { statusCode: 409, body: JSON.stringify({ error: 'Published posts cannot be deleted.' }) };
            }

            // Soft-cancel rather than hard-delete so the calendar history is preserved
            const [cancelled] = await db.update(scheduledPosts).set({
                status: 'cancelled',
                cancelledAt: new Date(),
                updatedAt: new Date(),
            }).where(eq(scheduledPosts.id, postId)).returning();

            return { statusCode: 200, body: JSON.stringify({ post: cancelled }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (err: any) {
        // Table not yet migrated — return empty payload so the calendar renders
        const msg: string = err?.message || '';
        if (msg.includes('relation') && msg.includes('does not exist')) {
            console.warn('[scheduled-posts] Table missing — run db:push to apply migrations.');
            if (event.httpMethod === 'GET' && !event.queryStringParameters?.id) {
                return { statusCode: 200, body: JSON.stringify({ posts: [] }) };
            }
            return { statusCode: 503, body: JSON.stringify({ error: 'Database schema not yet applied. Please run db:push.' }) };
        }
        console.error('Scheduled Posts Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
