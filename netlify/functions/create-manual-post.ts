// netlify/functions/create-manual-post.ts
// "Create Post" → Write your own (no AI). Creates one pending_approval scheduled_posts draft per
// selected platform from user-authored caption/hashtags, optionally attaching media the user picked
// from My Content (content_assets). The drafts land in the Review Queue → Social Drafts tab and flow
// through the same approve/schedule/reject path as AI-generated drafts (approve-post.ts) — no AI
// generation, no blueprint, no content_generation_jobs.

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    aiAssistants,
    contentAssets,
    scheduledPosts,
    scheduledPostAssets,
    users,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const VALID_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x'];

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    let body: {
        assistantId?: number;
        platforms?: string[];
        caption?: string;
        hashtags?: string;
        contentAssetIds?: number[];
    };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { assistantId } = body;
    const caption = (body.caption || '').trim();
    const hashtags = (body.hashtags || '').trim();
    const platforms = Array.isArray(body.platforms) ? [...new Set(body.platforms)] : [];
    const contentAssetIds = Array.isArray(body.contentAssetIds)
        ? [...new Set(body.contentAssetIds.filter(n => Number.isInteger(n)))]
        : [];

    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    if (!caption) return { statusCode: 400, body: JSON.stringify({ error: 'A caption is required.' }) };
    if (caption.length > 5000) return { statusCode: 400, body: JSON.stringify({ error: 'Caption is too long.' }) };
    if (platforms.length === 0) return { statusCode: 400, body: JSON.stringify({ error: 'Select at least one platform.' }) };
    const invalid = platforms.filter(p => !VALID_PLATFORMS.includes(p));
    if (invalid.length) return { statusCode: 400, body: JSON.stringify({ error: `Unsupported platform: ${invalid.join(', ')}.` }) };

    // Instagram cannot publish a text-only post — an image is mandatory. Other platforms may post
    // without media (the client prompts but allows it). Enforce the Instagram rule server-side too.
    if (platforms.includes('instagram') && contentAssetIds.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Instagram requires an image. Add one from My Content before adding to the queue.' }) };
    }

    // Verify the assistant belongs to this org.
    const [asst] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)))
        .limit(1);
    if (!asst) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    // Verify every selected asset belongs to this org (don't let a user attach someone else's media).
    if (contentAssetIds.length) {
        const owned = await db
            .select({ id: contentAssets.id })
            .from(contentAssets)
            .where(and(eq(contentAssets.organisationId, organisationId), inArray(contentAssets.id, contentAssetIds)));
        if (owned.length !== contentAssetIds.length) {
            return { statusCode: 400, body: JSON.stringify({ error: 'One or more selected media items could not be found.' }) };
        }
    }

    // Owner label shown on the review card ("Jane Smith") — distinguishes human-authored drafts.
    const [u] = await db
        .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    const ownerLabel = [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() || u?.email || 'You';

    const now = new Date();
    // Placeholder publish date — actual scheduling happens when the user approves the draft.
    const publishDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const postFormat = contentAssetIds.length > 0 ? 'image' : 'text';

    const created: Array<{ id: number; platform: string }> = [];
    for (const platform of platforms) {
        const [post] = await db.insert(scheduledPosts).values({
            userId,
            organisationId,
            assistantId,
            platform,
            postFormat,
            publishDate,
            caption,
            hashtags: hashtags || null,
            // publish-social-posts.ts reads media from this legacy JSONB column, so it must be set.
            contentAssetIds,
            status: 'pending_approval',
            triggerType: 'manual',
            isAutonomous: false,
            ownerId: userId,
            ownerLabel,
            generatedAt: now,
        }).returning({ id: scheduledPosts.id });

        // Junction rows for forward-compatibility (scheduled_post_assets is the SoT for new queries).
        if (contentAssetIds.length) {
            await db.insert(scheduledPostAssets)
                .values(contentAssetIds.map((contentAssetId, position) => ({
                    scheduledPostId: post.id,
                    contentAssetId,
                    position,
                })))
                .onConflictDoNothing();
        }

        created.push({ id: post.id, platform });
    }

    return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ created }),
    };
};
