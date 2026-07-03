// netlify/functions/get-social-drafts.ts
// US-SMM-3.4.1: Returns scheduled_posts with status='pending_approval' for the authenticated org.

import { Handler } from '@netlify/functions';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, aiAssistants, postIdeaSuggestions } from '../../db/schema';
import { resolvePostImage } from '../../src/utils/social-publish';
import { requireTenant } from '../../src/utils/tenant';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const db = getDb();

        // Resolve the *active* organisation from the session (re-verifying membership),
        // not the user's first membership — multi-org users were getting the wrong tenant.
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;
        const organisationId = ctx.organisationId;

        const statusFilter = event.queryStringParameters?.status || 'pending_approval';
        const assistantIdFilter = event.queryStringParameters?.assistantId
            ? Number(event.queryStringParameters.assistantId)
            : null;

        const drafts = await db
            .select({
                id: scheduledPosts.id,
                platform: scheduledPosts.platform,
                caption: scheduledPosts.caption,
                hashtags: scheduledPosts.hashtags,
                suggestedMediaDescription: scheduledPosts.suggestedMediaDescription,
                contentAssetIds: scheduledPosts.contentAssetIds,
                conflictNotice: scheduledPosts.conflictNotice,
                mediaMissing: scheduledPosts.mediaMissing,
                mediaMissingNote: scheduledPosts.mediaMissingNote,
                status: scheduledPosts.status,
                triggerType: scheduledPosts.triggerType,
                publishDate: scheduledPosts.publishDate,
                generatedAt: scheduledPosts.generatedAt,
                assistantId: scheduledPosts.assistantId,
                jobId: scheduledPosts.jobId,
                rejectionReason: scheduledPosts.rejectionReason,
                rejectedAt: scheduledPosts.rejectedAt,
                ctaText: scheduledPosts.ctaText,
                linkUrl: scheduledPosts.linkUrl,
                postFormat: scheduledPosts.postFormat,
                publishedAt: scheduledPosts.publishedAt,
                platformPostUrl: scheduledPosts.platformPostUrl,
                assistantName: aiAssistants.name,
                // When this draft was generated from a user-suggested idea, surface the original
                // idea text on the card so the reviewer can see what it was built from (closes the
                // loop between "Suggest an idea" and the draft now awaiting review).
                originIdea: postIdeaSuggestions.idea,
            })
            .from(scheduledPosts)
            .leftJoin(aiAssistants, eq(aiAssistants.id, scheduledPosts.assistantId))
            .leftJoin(postIdeaSuggestions, eq(postIdeaSuggestions.usedPostId, scheduledPosts.id))
            .where(and(
                eq(scheduledPosts.organisationId, organisationId),
                eq(scheduledPosts.status, statusFilter),
                ...(assistantIdFilter ? [eq(scheduledPosts.assistantId, assistantIdFilter)] : []),
            ))
            .orderBy(desc(scheduledPosts.generatedAt))
            .limit(50);

        // Resolve a preview thumbnail for the first attached image (presigned R2 or external URL).
        // Best-effort per draft — a resolution failure must never blank out the list.
        const ARCHIVE_RETENTION_DAYS = 30;
        const now = Date.now();
        const withThumbs = await Promise.all(drafts.map(async ({ contentAssetIds, ...d }) => {
            let thumbnailUrl: string | null = null;
            try { thumbnailUrl = (await resolvePostImage(db, contentAssetIds))?.url ?? null; } catch { /* ignore */ }
            // Archive countdown: rejected posts are kept 30 days from rejectedAt, then auto-deleted.
            let archiveDeletesAt: string | null = null;
            let daysRemaining: number | null = null;
            if (d.status === 'rejected' && d.rejectedAt) {
                const deletesAt = new Date(d.rejectedAt).getTime() + ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
                archiveDeletesAt = new Date(deletesAt).toISOString();
                daysRemaining = Math.max(0, Math.ceil((deletesAt - now) / (24 * 60 * 60 * 1000)));
            }
            return { ...d, thumbnailUrl, archiveDeletesAt, daysRemaining };
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ drafts: withThumbs }),
        };
    } catch (err) {
        console.error('[get-social-drafts]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error.' }) };
    }
};
