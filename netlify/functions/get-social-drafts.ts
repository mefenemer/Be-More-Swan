// netlify/functions/get-social-drafts.ts
// US-SMM-3.4.1: Returns scheduled_posts with status='pending_approval' for the authenticated org.

import { Handler } from '@netlify/functions';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, aiAssistants, postIdeaSuggestions, organisations, scheduledPostAssets, contentAssets, postRenderJobs, orchestrationRuns } from '../../db/schema';
import { resolvePostMedia, isVideoMedia, presignR2Get, resolvePostMediaList } from '../../src/utils/social-publish';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';
import { displayCaption } from '../../src/utils/model-json';
import { diagnosePostFailure } from '../../src/utils/post-failure-diagnosis';
import { PLATFORM_FORMATS } from '../../src/config/platform-formats';

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

        // ── Paging is OPT-IN, and it pages by GROUP ─────────────────────────────────────────────
        // Opt-in because eleven other callers hit this endpoint expecting the whole list — the post
        // editor's own refetch among them (_pceRefetchPostGroup). Silently defaulting to a page
        // would mean a post edited from position 11 was no longer in the response, so its cache
        // entry would never update and the reviewer would keep seeing the pre-save card.
        //
        // By group because a cross-post is one row PER PLATFORM sharing a crosspost_group_id, and
        // the Review Queue collapses those into a single card. A row-level LIMIT would cut a group
        // in half — Facebook on page 1, its LinkedIn sibling on page 2 — and render the same post
        // as two different cards, each claiming to be the whole thing.
        // Whether the caller opted in is decided by the PRESENCE of the param, never by a number
        // derived from it. `Math.max(1, Number(undefined) || 0)` is 1, not 0 — so clamping first and
        // then testing `pageSize > 0` made every unpaged caller a paged one asking for a single
        // group. The workspace queue looked fine because it sends limit explicitly; everything that
        // does not (the assistant-detail Review tab, the column counts, _pceRefetchPostGroup) got
        // exactly one post back.
        const rawLimit = event.queryStringParameters?.limit;
        const paged = rawLimit !== undefined && rawLimit !== null && rawLimit !== '';
        const pageSize = paged ? Math.min(50, Math.max(1, Number(rawLimit) || 10)) : 0;
        const pageOffset = Math.max(0, Number(event.queryStringParameters?.offset) || 0);

        // Two filters are FAMILIES, not statuses — the Review Queue column they back covers more
        // than one lifecycle value, and the expansion belongs here so every caller gets it:
        //   'scheduled' → committed work, including a post parked on X quota (paused_credits),
        //                 which is still booked and must not vanish from the Scheduled tab.
        //   'archived'  → rejected + cancelled. Both mean "not going out"; they differ only in who
        //                 stopped it. The column read 'rejected' alone, so cancelled posts were
        //                 reachable from nowhere in the product.
        // Anything else is an exact status match, as before.
        const STATUS_FAMILIES: Record<string, string[]> = {
            scheduled: ['scheduled', 'paused_credits'],
            archived: ['rejected', 'cancelled'],
        };
        const family = STATUS_FAMILIES[statusFilter];
        const baseWhere = and(
            eq(scheduledPosts.organisationId, organisationId),
            family ? inArray(scheduledPosts.status, family) : eq(scheduledPosts.status, statusFilter),
            ...(assistantIdFilter ? [eq(scheduledPosts.assistantId, assistantIdFilter)] : []),
        );

        // Which post ids make up this page. Three narrow columns, no joins and no presigned URLs —
        // the expensive part of this endpoint is resolving media per row, and that is exactly what
        // paging exists to avoid doing 50 times to show 10 cards.
        let pageIds: number[] | null = null;
        let groupTotal = 0;
        if (paged) {
            const keys = await db
                .select({
                    id: scheduledPosts.id,
                    crosspostGroupId: scheduledPosts.crosspostGroupId,
                    status: scheduledPosts.status,
                })
                .from(scheduledPosts)
                .where(baseWhere)
                .orderBy(desc(scheduledPosts.generatedAt));

            // Same key as the browser's _rqGroupKey, so the server's idea of "one card" and the
            // client's cannot disagree about where a page ends.
            const order: string[] = [];
            const byKey = new Map<string, number[]>();
            for (const r of keys) {
                const key = r.crosspostGroupId ? `g:${r.crosspostGroupId}|${r.status ?? ''}` : `id:${r.id}`;
                if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
                byKey.get(key)!.push(r.id);
            }
            groupTotal = order.length;
            pageIds = order.slice(pageOffset, pageOffset + pageSize).flatMap(k => byKey.get(k)!);
            // A page past the end has no ids; short-circuit rather than send `inArray(id, [])`.
            if (pageIds.length === 0) {
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ drafts: [], total: groupTotal, hasMore: false }),
                };
            }
        }

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
                // Origin attribution for the Review Queue's pill. trigger_type alone can't tell the
                // whole story: a draft regenerated after a rejection inherits its parent's trigger,
                // and a human-written post is identified by who owns it, not by how it was made.
                isRevised: scheduledPosts.isRevised,
                ownerLabel: scheduledPosts.ownerLabel,
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
                audioOverlays: scheduledPosts.audioOverlays,
                // Phase 4 video overlay render state. Every publisher claims only rows where this is
                // NULL or 'done', so a post stuck at 'pending'/'rendering'/'failed' will NEVER go out
                // — and without it on the card the reviewer has no way to see that. It is the one
                // post state that is invisible from the outside: status still reads 'scheduled'.
                renderStatus: scheduledPosts.renderStatus,
                // The chosen post format ('ig_reel', 'x_poll'…). Drives the editor's whole layout —
                // aspect ratio, media kind, slide count, character cap. See src/config/post-formats.ts.
                formatKey: scheduledPosts.formatKey,
                assistantName: aiAssistants.name,
                // When this draft was generated from a user-suggested idea, surface the original
                // idea text on the card so the reviewer can see what it was built from (closes the
                // loop between "Suggest an idea" and the draft now awaiting review).
                originIdea: postIdeaSuggestions.idea,
            })
            .from(scheduledPosts)
            .leftJoin(aiAssistants, eq(aiAssistants.id, scheduledPosts.assistantId))
            .leftJoin(postIdeaSuggestions, eq(postIdeaSuggestions.usedPostId, scheduledPosts.id))
            // baseWhere carries the org/status/assistant filter — including the 'paused_credits'
            // rule (X posts waiting on next month's allowance are scheduled posts, not failures, so
            // the Scheduled tab must show them). On a paged request the id list narrows it to this
            // page's groups, which is the only difference between the two modes.
            .where(paged ? and(baseWhere, inArray(scheduledPosts.id, pageIds!)) : baseWhere)
            .orderBy(desc(scheduledPosts.generatedAt))
            // Unpaged callers keep the original ceiling. Paged ones are already bounded by pageIds,
            // and a cross-post group can be several rows wide, so a flat 50 could truncate the last
            // group of a page — the exact split this pages by group to avoid.
            .limit(paged ? pageIds!.length : 50);

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

        // Which assistant handed off to produce an orchestration draft. Only looked up for the
        // drafts actually in that state — hand-offs are rare, so this stays off the hot path rather
        // than adding two more joins to the main query for a column almost every row leaves null.
        // Best-effort: without it the card falls back to a generic "Team hand-off" pill.
        const handoffFrom = new Map<number, string>();
        const handoffJobIds = drafts.filter(d => d.triggerType === 'orchestration' && d.jobId).map(d => d.jobId!);
        if (handoffJobIds.length) {
            try {
                const rows = await db
                    .select({ jobId: orchestrationRuns.targetJobId, sourceName: aiAssistants.name })
                    .from(orchestrationRuns)
                    .leftJoin(aiAssistants, eq(aiAssistants.id, orchestrationRuns.sourceAssistantId))
                    .where(and(
                        eq(orchestrationRuns.organisationId, organisationId),
                        inArray(orchestrationRuns.targetJobId, handoffJobIds),
                    ));
                const byJob = new Map(rows.filter(r => r.jobId && r.sourceName).map(r => [r.jobId!, r.sourceName!]));
                for (const d of drafts) {
                    const name = d.jobId ? byJob.get(d.jobId) : undefined;
                    if (name) handoffFrom.set(d.id, name);
                }
            } catch (err) {
                console.warn('[get-social-drafts] hand-off source lookup skipped:', err instanceof Error ? err.message : err);
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

        // ── Audio clips on these drafts ──────────────────────────────────────────────────────────
        // The saved arrangement is just asset ids and times; the editor needs something it can PLAY
        // and a name to put on the track. Resolved for the whole page in one query + one presign per
        // distinct asset, not per clip: the same voice note is usually on several platform siblings,
        // and presigning it once per sibling would be three signatures for one file.
        //
        // Best-effort throughout. A clip whose asset has been deleted is dropped rather than handed
        // to the editor as an unplayable row — the arrangement it came from is still on the post, and
        // save-post-audio would reject the dead id anyway.
        const audioAssets = new Map<number, { name: string; url: string | null }>();
        if (drafts.length) {
            const audioIds = [...new Set(
                drafts.flatMap(d => (Array.isArray(d.audioOverlays) ? d.audioOverlays as Array<{ assetId?: unknown }> : []))
                    .map(a => Number(a?.assetId))
                    .filter(id => Number.isInteger(id) && id > 0),
            )];
            if (audioIds.length) {
                try {
                    const rows = await db
                        .select({
                            id: contentAssets.id, name: contentAssets.name, assetType: contentAssets.assetType,
                            storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
                        })
                        .from(contentAssets)
                        .where(and(inArray(contentAssets.id, audioIds), eq(contentAssets.organisationId, organisationId)));
                    for (const r of rows) {
                        if ((r.assetType ?? '').toLowerCase() !== 'audio') continue;
                        let url: string | null = null;
                        if (r.storageKey) { try { url = await presignR2Get(r.storageKey, 3600); } catch { /* fall through */ } }
                        audioAssets.set(r.id, { name: r.name, url: url ?? r.externalUrl ?? null });
                    }
                } catch (err) {
                    // audio_overlays column not applied in this environment — degrade to "no audio",
                    // never to an empty review queue.
                    console.warn('[get-social-drafts] audio lookup skipped:', err instanceof Error ? err.message : err);
                }
            }
        }

        // Resolve a preview URL for the post's attachment — image OR VIDEO (presigned R2 or external).
        // Best-effort per draft — a resolution failure must never blank out the list.
        //
        // resolvePostMedia, not resolvePostImage: the image-only resolver returned null for a post
        // whose single attachment is a clip, so a video post came back from the server carrying no
        // media at all. Everything downstream keys off thumbnailUrl — the canvas fell back to "Add a
        // photo or a video", `overlayCapable` went false so the text layer was never even mounted,
        // and any refetch mid-session (which replaces the cached post wholesale) wiped the URL the
        // client had set locally when the clip was attached. The video only ever appeared to work
        // between attaching it and the next refetch. resolvePostMedia also presigns a video for an
        // hour rather than ten minutes, which is what streaming one across an editing session needs.
        const ARCHIVE_RETENTION_DAYS = 30;
        const now = Date.now();
        const withThumbs = await Promise.all(drafts.map(async ({ contentAssetIds, imageOverlays, audioOverlays, ...d }) => {
            let thumbnailUrl: string | null = null;
            let mediaType: 'image' | 'video' | null = null;
            try {
                const media = await resolvePostMedia(db, contentAssetIds);
                thumbnailUrl = media?.url ?? null;
                // The client decides <video> vs <img> from this. It used to infer the kind from the
                // post FORMAT, which is right for a Reel and wrong for a clip on a plain feed post —
                // and a video rendered into an <img> is a broken-image icon, not a preview.
                mediaType = media ? (isVideoMedia(media) ? 'video' : 'image') : null;
            } catch { /* ignore */ }
            // Carousel slides, in order — but ONLY for posts that actually have more than one
            // attachment. Resolving every draft's full list would presign up to 50 × 20 objects to
            // populate a queue whose cards show one thumbnail each; the single-media case, which is
            // almost every post, keeps costing exactly one presign.
            const slideIds = Array.isArray(contentAssetIds) ? (contentAssetIds as number[]) : [];
            let slides: Array<{ assetId: number; url: string; kind: string }> = [];
            if (slideIds.length > 1) {
                try {
                    slides = (await resolvePostMediaList(db, slideIds))
                        .map(s => ({ assetId: s.assetId, url: s.url, kind: s.kind }));
                } catch { /* a carousel that won't resolve still renders as its thumbnail */ }
            }
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
            // …and the same blob classified into a cause the reviewer can act on. failureMessage is
            // the platform's own words and stays exactly as it was (the Data Hub renders it); this is
            // the plain-English "what happened / what to do", which is what the Review Queue's
            // Needs-attention column needs to offer buttons at all. Computed for every failed post,
            // including one whose failure_reason is null — diagnosePostFailure has a branch for that
            // rather than leaving the card blank.
            const failure = d.status === 'failed'
                ? diagnosePostFailure(
                    d.failureReason as Parameters<typeof diagnosePostFailure>[0],
                    PLATFORM_FORMATS[d.platform as keyof typeof PLATFORM_FORMATS]?.label || 'The platform',
                  )
                : null;
            // Older rows can hold a raw model reply (fenced JSON) in `caption` — unwrap it so the
            // editor shows the copy, and an edit-and-save persists the repair.
            // brandCard non-null ⇒ the review UI offers "Edit card" for this draft.
            return { ...d, caption: displayCaption(d.caption), thumbnailUrl, mediaType, archiveDeletesAt, daysRemaining, failureMessage, failure,
                // Why the video render failed, when it did — null in every other state.
                renderError: d.renderStatus === 'failed' ? (renderErrors.get(d.id) ?? null) : null,
                brandCard: brandCards.get(d.id) ?? null,
                // Name of the assistant whose post triggered this hand-off — orchestration drafts only.
                handoffFrom: handoffFrom.get(d.id) ?? null,
                // The saved text-overlay design, so the Review canvas can paint it live on open without
                // a per-post get-post-image round trip. Normalised to an array the client renders directly.
                slides,
                overlays: Array.isArray(imageOverlays) ? imageOverlays : [],
                // The saved audio arrangement, each clip carrying a playable url + name so the
                // editor can draw its track and let the reviewer hear it without another round trip.
                audio: (Array.isArray(audioOverlays) ? audioOverlays as Array<Record<string, unknown>> : [])
                    .map(a => {
                        const asset = audioAssets.get(Number(a?.assetId));
                        return asset ? { ...a, url: asset.url, name: asset.name } : null;
                    })
                    .filter(Boolean) };
        }));

        // Workspace-wide footer state — drives whether the per-post "include disclosure footer"
        // toggle is shown in the review modal (there's nothing to opt out of when it's off).
        const [org] = await db.select({ enabled: organisations.aiDisclosureFooterEnabled })
            .from(organisations).where(eq(organisations.id, organisationId)).limit(1);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            // total/hasMore are counted in GROUPS, because that is what the caller renders — a card
            // per group. Reporting rows would make "24 posts" disagree with the 24 cards on screen.
            body: JSON.stringify({
                drafts: withThumbs,
                disclosureFooterEnabled: org?.enabled ?? false,
                ...(paged ? { total: groupTotal, hasMore: pageOffset + pageSize < groupTotal } : {}),
            }),
        };
    } catch (err) {
        console.error('[get-social-drafts]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error.' }) };
    }
});
