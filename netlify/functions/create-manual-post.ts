// netlify/functions/create-manual-post.ts
// "Create Post" → Write your own (no AI). Creates one pending_approval scheduled_posts draft per
// chosen DESTINATION from user-authored caption/hashtags, optionally attaching media the user picked
// from My Content (content_assets). The drafts land in the Review Queue → Social Drafts tab and flow
// through the same approve/schedule/reject path as AI-generated drafts (approve-post.ts) — no AI
// generation, no blueprint, no content_generation_jobs.
//
// A destination is a platform AND a format — see src/utils/post-destinations.ts. It used to be a
// platform alone, which is why "Instagram, Reel, nothing else" was unaskable: the row was created
// format-less and whatever the media routed to became the answer.

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
import { platformFormat } from '../../src/config/platform-formats';
import { postFormatSpec } from '../../src/config/post-formats';
import { parseDestinations, legacyPostFormat, canonicalPlatform } from '../../src/utils/post-destinations';

// The platform allow-list is NOT here. It used to be a local `VALID_PLATFORMS` copy that predated
// Threads and YouTube, so "Write your own" rejected both while offering them; it then became an
// alias for SOCIAL_PLATFORMS, and is now gone entirely — parseDestinations validates against
// SOCIAL_PLATFORMS itself, so there is one list and one check for both request shapes.

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    let body: {
        assistantId?: number;
        platforms?: string[];
        destinations?: Array<{ platform?: string; formatKey?: string | null }>;
        caption?: string;
        hashtags?: string;
        contentAssetIds?: number[];
        blank?: boolean;
    };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { assistantId } = body;
    const caption = (body.caption || '').trim();
    const hashtags = (body.hashtags || '').trim();
    const contentAssetIds = Array.isArray(body.contentAssetIds)
        ? [...new Set(body.contentAssetIds.filter(n => Number.isInteger(n)))]
        : [];

    // Both request shapes, one parser. No `existingFormatFor` here — nothing exists yet to inherit
    // a format from, so a legacy `platforms` request means exactly what it always meant: these
    // platforms, format derived from the media.
    const parsed = parseDestinations(body);
    const destinations = parsed.destinations;

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
    if (parsed.error) return { statusCode: 400, body: JSON.stringify({ error: parsed.error }) };

    // Some destinations cannot publish without media at all.
    //
    // A DECLARED format answers this better than the platform can: "Instagram" is media-mandatory as
    // a platform, but the requirement is one image for a feed post, one video for a Reel and two-plus
    // items for a carousel — and the message can now say which. Falls back to PLATFORM_FORMATS where
    // no format was declared, which is what a legacy `platforms` request still gets.
    //
    // Skipped for a blank draft: it has no media BY DEFINITION, and refusing to create the thing the
    // user is about to add media to would make Instagram impossible to start a post for at all.
    // approve-post enforces the same rule at the point it can actually be satisfied.
    const needsMedia = blank ? [] : destinations.filter(d => {
        const spec = d.formatKey ? postFormatSpec(d.formatKey) : null;
        return spec ? spec.mediaMandatory : platformFormat(canonicalPlatform(d.platform)).mediaMandatory;
    });
    if (needsMedia.length && contentAssetIds.length === 0) {
        const which = needsMedia.map(d => {
            const spec = d.formatKey ? postFormatSpec(d.formatKey) : null;
            const label = platformFormat(canonicalPlatform(d.platform)).label;
            return spec ? `${label} ${spec.label}` : label;
        }).join(' and ');
        const allVideo = needsMedia.every(d => {
            const spec = d.formatKey ? postFormatSpec(d.formatKey) : null;
            return spec ? spec.media === 'video' : platformFormat(canonicalPlatform(d.platform)).mediaKind === 'video';
        });
        return { statusCode: 400, body: JSON.stringify({ error: `${which} requires ${allVideo ? 'a video' : 'an image'}. Add one from My Content before adding to the queue.` }) };
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
    const hasMedia = contentAssetIds.length > 0;

    // One shared id across the fanned-out rows so the Review Queue collapses them into one card. Only
    // a genuine cross-post (2+ destinations) needs it — a single-destination post stays null
    // (standalone), which the queue renders as its own card anyway.
    //
    // Counted in DESTINATIONS, not platforms: a Reel and a carousel both on Instagram are two rows
    // and genuinely are one post with two destinations, so they share a group like any other pair.
    const crosspostGroupId = destinations.length > 1 ? randomUUID() : null;

    const created: Array<{ id: number; platform: string; formatKey: string | null }> = [];
    for (const dest of destinations) {
        const [post] = await db.insert(scheduledPosts).values({
            userId,
            organisationId,
            assistantId,
            platform: dest.platform,
            postFormat: legacyPostFormat(dest, hasMedia),
            formatKey: dest.formatKey,
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

        created.push({ id: post.id, platform: dest.platform, formatKey: dest.formatKey });
    }

    return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ created }),
    };
});
