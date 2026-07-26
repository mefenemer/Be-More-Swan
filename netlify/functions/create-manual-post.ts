// netlify/functions/create-manual-post.ts
// "Create Post" → Write your own (no AI). Creates one pending_approval scheduled_posts draft per
// selected platform from user-authored caption/hashtags, optionally attaching media the user picked
// from My Content (content_assets). The drafts land in the Review Queue → Social Drafts tab and flow
// through the same approve/schedule/reject path as AI-generated drafts (approve-post.ts) — no AI
// generation, no blueprint, no content_generation_jobs.

import { Handler } from '@netlify/functions';
import { randomUUID } from 'crypto';
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
import { withLambda } from '@netlify/aws-lambda-compat';
import { SOCIAL_PLATFORMS, platformFormat } from '../../src/config/platform-formats';

// The canonical list, not a local copy — the copy that used to live here predated Threads and
// YouTube, so "Write your own" rejected both with "Unsupported platform" while offering them.
const VALID_PLATFORMS: string[] = SOCIAL_PLATFORMS;

export default withLambda(async (event) => {
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
        blank?: boolean;
    };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { assistantId } = body;
    const caption = (body.caption || '').trim();
    const hashtags = (body.hashtags || '').trim();
    const platforms = Array.isArray(body.platforms) ? [...new Set(body.platforms)] : [];
    const contentAssetIds = Array.isArray(body.contentAssetIds)
        ? [...new Set(body.contentAssetIds.filter(n => Number.isInteger(n)))]
        : [];

    // ── Blank mode: an empty post for the editor to open on ─────────────────────────────────────
    // "Create Post" now opens the three-pane editor rather than a separate composer, and the editor
    // edits a row — so a row has to exist before there is anything to write. A blank draft therefore
    // has no caption, no media and no platform commitment yet, and every completeness rule below is
    // deferred to approval, where it can be answered rather than guessed.
    //
    // It lands in 'draft', NOT 'pending_approval'. That is what stops an abandoned blank post
    // cluttering the Review Queue: RQ_COLUMNS has no draft column, so it is invisible there until
    // the user actually asks for it to be queued.
    const blank = body.blank === true;

    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    if (!blank && !caption) return { statusCode: 400, body: JSON.stringify({ error: 'A caption is required.' }) };
    if (caption.length > 5000) return { statusCode: 400, body: JSON.stringify({ error: 'Caption is too long.' }) };
    if (platforms.length === 0) return { statusCode: 400, body: JSON.stringify({ error: 'Select at least one platform.' }) };
    const invalid = platforms.filter(p => !VALID_PLATFORMS.includes(p));
    if (invalid.length) return { statusCode: 400, body: JSON.stringify({ error: `Unsupported platform: ${invalid.join(', ')}.` }) };

    // Some platforms cannot publish a text-only post at all. Driven by PLATFORM_FORMATS rather than
    // naming Instagram, because YouTube has the same rule and a stricter one: it needs a VIDEO, and
    // a YouTube draft carrying only a still is unpublishable by construction — better refused here
    // than discovered at publish time.
    //
    // Skipped for a blank draft: it has no media BY DEFINITION, and refusing to create the thing the
    // user is about to add media to would make Instagram impossible to start a post for at all.
    // approve-post enforces the same rule at the point it can actually be satisfied.
    const needsMedia = blank ? [] : platforms.filter(p => platformFormat(p).mediaMandatory);
    if (needsMedia.length && contentAssetIds.length === 0) {
        const which = needsMedia.map(p => platformFormat(p).label).join(' and ');
        const kind = needsMedia.every(p => platformFormat(p).mediaKind === 'video') ? 'a video' : 'an image';
        return { statusCode: 400, body: JSON.stringify({ error: `${which} requires ${kind}. Add one from My Content before adding to the queue.` }) };
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

    // One shared id across the fanned-out platform rows so the Review Queue collapses them into one
    // card. Only a genuine cross-post (2+ platforms) needs it — a single-platform post stays null
    // (standalone), which the queue renders as its own card anyway.
    const crosspostGroupId = platforms.length > 1 ? randomUUID() : null;

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
            status: blank ? 'draft' : 'pending_approval',
            triggerType: 'manual',
            isAutonomous: false,
            ownerId: userId,
            ownerLabel,
            generatedAt: now,
            crosspostGroupId,
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
});
