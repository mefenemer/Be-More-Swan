// netlify/functions/get-social-drafts.ts
// US-SMM-3.4.1: Returns scheduled_posts with status='pending_approval' for the authenticated org.

import { Handler } from '@netlify/functions';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, aiAssistants, postIdeaSuggestions, organisations, scheduledPostAssets, contentAssets, postRenderJobs } from '../../db/schema';
import { resolvePostImage } from '../../src/utils/social-publish';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';
import { displayCaption } from '../../src/utils/model-json';

export default withLambda(async (event) => {
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
                crosspostGroupId: scheduledPosts.crosspostGroupId,
                rejectionReason: scheduledPosts.rejectionReason,
                rejectedAt: scheduledPosts.rejectedAt,
                // Failure state — without these a 'failed' post surfaces in the Content Library with
                // no explanation and no way back into the queue (Request 6).
                failureReason: scheduledPosts.failureReason,
                attemptCount: scheduledPosts.attemptCount,
                retryAt: scheduledPosts.retryAt,
                ctaText: scheduledPosts.ctaText,
                linkUrl: scheduledPosts.linkUrl,
                postFormat: scheduledPosts.postFormat,
                publishedAt: scheduledPosts.publishedAt,
                platformPostUrl: scheduledPosts.platformPostUrl,
                disclosureFooterDisabled: scheduledPosts.disclosureFooterDisabled,
                imageOverlays: scheduledPosts.imageOverlays,
                // Phase 4 video overlay render state. Every publisher claims only rows where this is
                // NULL or 'done', so a post stuck at 'pending'/'rendering'/'failed' will NEVER go out
                // — and without it on the card the reviewer has no way to see that. It is the one
                // post state that is invisible from the outside: status still reads 'scheduled'.
                renderStatus: scheduledPosts.renderStatus,
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
                // X posts paused for credit exhaustion ('paused_credits') are scheduled posts waiting
                // on next month's X allowance — not failures — so surface them in the Scheduled tab
                // alongside 'scheduled' rather than leaving them invisible.
                statusFilter === 'scheduled'
                    ? inArray(scheduledPosts.status, ['scheduled', 'paused_credits'])
                    : eq(scheduledPosts.status, statusFilter),
                ...(assistantIdFilter ? [eq(scheduledPosts.assistantId, assistantIdFilter)] : []),
            ))
            .orderBy(desc(scheduledPosts.generatedAt))
            .limit(50);

        // Why a failed video render failed. Only for the drafts actually in that state, in one query
        // — "the render failed" alone tells a reviewer nothing they can act on, and this is a dead
        // end for the post until someone does. Best-effort: no message just means a bare warning.
        const renderErrors = new Map<number, string>();
        const failedRenderIds = drafts.filter(d => d.renderStatus === 'failed').map(d => d.id);
        if (failedRenderIds.length) {
            try {
                const rows = await db
                    .select({ postId: postRenderJobs.postId, errorMessage: postRenderJobs.errorMessage, createdAt: postRenderJobs.createdAt })
                    .from(postRenderJobs)
                    .where(inArray(postRenderJobs.postId, failedRenderIds))
                    .orderBy(desc(postRenderJobs.createdAt));
                // Newest first, so the first row per post wins — a retried post has several.
                for (const r of rows) {
                    if (r.errorMessage && !renderErrors.has(r.postId)) renderErrors.set(r.postId, r.errorMessage);
                }
            } catch (err) {
                // db/post-render-jobs.sql not applied in this environment — degrade to a bare
                // warning rather than emptying the review queue.
                console.warn('[get-social-drafts] render-error lookup skipped:', err instanceof Error ? err.message : err);
            }
        }

        // Which of these drafts carry an editable branded text card. One query for the whole page
        // rather than one per draft — this only drives whether an "Edit card" button appears, and
        // it must not cost 50 round-trips to find out.
        const brandCards = new Map<number, { assetId: number; headline: string | null; renderParams: unknown }>();
        if (drafts.length) {
            try {
                const rows = await db
                    .select({
                        postId: scheduledPostAssets.scheduledPostId,
                        assetId: contentAssets.id,
                        headline: contentAssets.prompt,
                        renderParams: contentAssets.renderParams,
                    })
                    .from(scheduledPostAssets)
                    .innerJoin(contentAssets, eq(contentAssets.id, scheduledPostAssets.contentAssetId))
                    .where(and(
                        inArray(scheduledPostAssets.scheduledPostId, drafts.map((d) => d.id)),
                        eq(contentAssets.provider, 'brand_card'),
                    ));
                for (const r of rows) brandCards.set(r.postId, { assetId: r.assetId, headline: r.headline, renderParams: r.renderParams });
            } catch (err) {
                // A missing render_params column (migration not yet applied) must degrade to "no
                // edit button", never to an empty review queue.
                console.warn('[get-social-drafts] brand-card lookup skipped:', err instanceof Error ? err.message : err);
            }
        }

        // Resolve a preview thumbnail for the first attached image (presigned R2 or external URL).
        // Best-effort per draft — a resolution failure must never blank out the list.
        const ARCHIVE_RETENTION_DAYS = 30;
        const now = Date.now();
        const withThumbs = await Promise.all(drafts.map(async ({ contentAssetIds, imageOverlays, ...d }) => {
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
            // Every publisher stores failure_reason as { httpStatus, errorMessage, isRetryable },
            // but flatten it defensively — older/foreign rows may hold a bare string, and the UI
            // must show *something* useful rather than "[object Object]".
            let failureMessage: string | null = null;
            if (d.status === 'failed' && d.failureReason != null) {
                const fr = d.failureReason as Record<string, unknown> | string;
                failureMessage = typeof fr === 'string'
                    ? fr
                    : (typeof fr?.errorMessage === 'string' ? fr.errorMessage : null);
            }
            // Older rows can hold a raw model reply (fenced JSON) in `caption` — unwrap it so the
            // editor shows the copy, and an edit-and-save persists the repair.
            // brandCard non-null ⇒ the review UI offers "Edit card" for this draft.
            return { ...d, caption: displayCaption(d.caption), thumbnailUrl, archiveDeletesAt, daysRemaining, failureMessage,
                // Why the video render failed, when it did — null in every other state.
                renderError: d.renderStatus === 'failed' ? (renderErrors.get(d.id) ?? null) : null,
                brandCard: brandCards.get(d.id) ?? null,
                // The saved text-overlay design, so the Review canvas can paint it live on open without
                // a per-post get-post-image round trip. Normalised to an array the client renders directly.
                overlays: Array.isArray(imageOverlays) ? imageOverlays : [] };
        }));

        // Workspace-wide footer state — drives whether the per-post "include disclosure footer"
        // toggle is shown in the review modal (there's nothing to opt out of when it's off).
        const [org] = await db.select({ enabled: organisations.aiDisclosureFooterEnabled })
            .from(organisations).where(eq(organisations.id, organisationId)).limit(1);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ drafts: withThumbs, disclosureFooterEnabled: org?.enabled ?? false }),
        };
    } catch (err) {
        console.error('[get-social-drafts]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error.' }) };
    }
});
