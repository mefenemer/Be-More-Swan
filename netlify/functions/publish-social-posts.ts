// netlify/functions/publish-social-posts.ts
// Publish due LinkedIn & X (Twitter) posts every minute — the non-Instagram half of the
// social publisher. Mirrors publish-instagram's orchestration (claim FOR UPDATE SKIP
// LOCKED → 'publishing' → API call → 'published' | retry/backoff | 'failed'), minus the
// Meta media-container flow. Posts the attached image when present (best-effort; falls
// back to text-only if media upload fails). Refreshes expired X tokens on 401 and retries.
//
// NOTE: the per-platform API calls (incl. media upload) follow the documented contracts
// but have NOT been validated against the live LinkedIn/X APIs — verify with real
// connected accounts. Facebook is excluded: it has no distinct connection yet.

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, systemConnections, rateLimitStates, publishCronLog, notifications } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { resolvePostImage, refreshXToken, fetchImageBytes, type PostImage } from '../../src/utils/social-publish';
import { recordPostedAssets } from '../../src/utils/pexels';
import { fireOrchestrations } from '../../src/utils/orchestration';

const BATCH = 100;
const BACKOFF_MINS = [2, 8, 30];
const MAX_ATTEMPTS = 3;
const LABEL: Record<string, string> = { linkedin: 'LinkedIn', x: 'X (Twitter)' };
const X_MAX = 280;
// A row left in 'publishing' longer than this was orphaned by a timed-out tick — reclaim it.
const STALE_PUBLISHING_MINS = 10;

type FailureReason = { httpStatus: number | null; errorMessage: string; isRetryable: boolean };
type PostRow = {
    id: number; user_id: number; organisation_id: number; caption: string | null;
    hashtags: string | null; connection_id: number | null; attempt_count: number;
    publish_date: string; platform: string; content_asset_ids: unknown;
    assistant_id: number | null;
};
type DriverResult = { ok: true; id: string } | { ok: false; status: number | null; error: string };

const isRetryable = (s: number | null) => s === 429 || (s != null && s >= 500);
const esc = (s: string) => s.replace(/'/g, "''");

export const handler: Handler = async () => {
    const db = getDb();
    const tickStart = Date.now();
    const now = new Date();
    let processed = 0, succeeded = 0, failed = 0;

    // Self-heal: reclaim posts stranded in 'publishing' by an earlier timed-out tick so they
    // are retried instead of sitting un-published forever (nothing else re-selects 'publishing').
    await db.execute(
        `UPDATE scheduled_posts SET status = 'scheduled', retry_at = NULL, updated_at = now()
         WHERE status = 'publishing' AND platform IN ('linkedin','x')
           AND updated_at < now() - interval '${STALE_PUBLISHING_MINS} minutes'`
    );

    const posts = await db.execute<PostRow>(
        `SELECT id, user_id, organisation_id, caption, hashtags, connection_id,
                attempt_count, publish_date, platform, content_asset_ids, assistant_id
         FROM scheduled_posts
         WHERE status = 'scheduled'
           AND platform IN ('linkedin','x')
           AND publish_date <= now()
           AND (retry_at IS NULL OR retry_at <= now())
         ORDER BY publish_date
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`
    );

    if (!posts.length) {
        await db.insert(publishCronLog).values({ postsProcessed: 0, postsSucceeded: 0, postsFailed: 0, durationMs: Date.now() - tickStart });
        return { statusCode: 200, body: 'no posts due' };
    }

    await db.update(scheduledPosts).set({ status: 'publishing', updatedAt: new Date() })
        .where(inArray(scheduledPosts.id, posts.map(p => p.id)));
    processed = posts.length;

    await Promise.allSettled(posts.map(async post => {
        try {
            // Resolve connection — by id, else the org's active connection for the platform.
            const connWhere = post.connection_id
                ? eq(systemConnections.id, post.connection_id)
                : and(
                    eq(systemConnections.organisationId, post.organisation_id),
                    eq(systemConnections.serviceName, post.platform),
                    eq(systemConnections.isActive, true),
                  );
            const [conn] = await db.select({
                id: systemConnections.id,
                vaultRefKey: systemConnections.vaultRefKey,
                externalUserId: systemConnections.externalUserId,
            }).from(systemConnections).where(connWhere).limit(1);
            if (!conn?.vaultRefKey) throw new Error(`No active ${post.platform} connection for this post.`);

            const secret = await getSecret(db, conn.vaultRefKey);
            let token = secret?.token as string | undefined;
            if (!token) throw new Error('No token in vault for connection.');

            const text = [post.caption, post.hashtags].filter(Boolean).join('\n\n').trim();
            if (!text) throw new Error('Post has no text to publish.');

            // Attached image (best-effort — text-only if absent/unresolvable).
            const image = await resolvePostImage(db, post.content_asset_ids).catch(() => null);

            let result: DriverResult;
            if (post.platform === 'x') {
                result = await publishX(text, token, image);
                // Token expired → refresh once and retry.
                if (!result.ok && result.status === 401) {
                    const fresh = await refreshXToken(db, conn.vaultRefKey);
                    if (fresh) { token = fresh; result = await publishX(text, token, image); }
                }
            } else {
                result = await publishLinkedIn(text, token, conn.externalUserId, image);
            }

            if (!result.ok) {
                await handleFailure(db, post, { httpStatus: result.status, errorMessage: result.error, isRetryable: isRetryable(result.status) }, now);
                if (!isRetryable(result.status)) failed++;
                return;
            }

            await db.execute(
                `UPDATE scheduled_posts SET status = 'published', platform_post_id = '${esc(result.id)}', published_at = now(), updated_at = now() WHERE id = ${post.id}`
            );
            // US2 AC2.5: burn any Pexels asset on this post so it is never reused (idempotent;
            // covers autonomous posts that bypass manual approval). Never blocks publish success.
            await recordPostedAssets(db, { orgId: post.organisation_id, userId: post.user_id, scheduledPostId: post.id })
                .catch(e => console.warn(`[publish-social-posts] recordPostedAssets failed for post ${post.id}:`, e?.message || e));
            await db.insert(notifications).values({
                userId: post.user_id,
                type: 'post_published',
                title: `Post published to ${LABEL[post.platform]}`,
                message: `Your post has been published to ${LABEL[post.platform]}.`,
                metadata: { postId: post.id, platform: post.platform, platformPostId: result.id },
            });
            // Orchestration (Phase 5): this assistant just published — hand off to any linked
            // assistants. Best-effort; never throws. Each downstream draft still needs approval.
            if (post.assistant_id) {
                await fireOrchestrations(db, {
                    sourceAssistantId: post.assistant_id,
                    orgId: post.organisation_id,
                    userId: post.user_id,
                    event: 'publishes_a_post',
                    sourcePostId: post.id,
                    sourceCaption: post.caption ?? null,
                });
            }
            succeeded++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[publish-social-posts] post ${post.id} error:`, msg);
            await handleFailure(db, post, { httpStatus: null, errorMessage: msg, isRetryable: true }, now);
        }
    }));

    const durationMs = Date.now() - tickStart;
    await db.insert(publishCronLog).values({ postsProcessed: processed, postsSucceeded: succeeded, postsFailed: failed, durationMs });
    return { statusCode: 200, body: JSON.stringify({ processed, succeeded, failed, durationMs }) };
};

// ── X (Twitter) ──────────────────────────────────────────────────────────────
async function publishX(text: string, token: string, image: PostImage | null): Promise<DriverResult> {
    let mediaId: string | null = null;
    if (image) { try { mediaId = await uploadXMedia(image, token); } catch { /* text-only on media failure */ } }

    const body: Record<string, unknown> = { text: text.slice(0, X_MAX) };
    if (mediaId) body.media = { media_ids: [mediaId] };

    const res = await fetch('https://api.twitter.com/2/tweets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.data?.id) return { ok: true, id: String(data.data.id) };
    return { ok: false, status: res.status, error: data?.detail || data?.title || `X API error (${res.status})` };
}

// Simple upload via media_data (base64). Returns media_id_string or null (→ text-only).
async function uploadXMedia(image: PostImage, token: string): Promise<string | null> {
    const bytes = await fetchImageBytes(image.url);
    const res = await fetch('https://upload.twitter.com/1.1/media/upload.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
        body: new URLSearchParams({ media_data: Buffer.from(bytes).toString('base64') }),
    });
    const data: any = await res.json().catch(() => ({}));
    return res.ok ? (data?.media_id_string ?? null) : null;
}

// ── LinkedIn ─────────────────────────────────────────────────────────────────
async function publishLinkedIn(text: string, token: string, authorId: string | null, image: PostImage | null): Promise<DriverResult> {
    if (!authorId) return { ok: false, status: null, error: 'No LinkedIn author URN on connection.' };
    const author = authorId.startsWith('urn:') ? authorId : `urn:li:person:${authorId}`;

    let assetUrn: string | null = null;
    if (image) { try { assetUrn = await uploadLinkedInImage(image, token, author); } catch { /* text-only on media failure */ } }

    const shareContent: Record<string, unknown> = {
        shareCommentary: { text },
        shareMediaCategory: assetUrn ? 'IMAGE' : 'NONE',
    };
    if (assetUrn) shareContent.media = [{ status: 'READY', media: assetUrn }];

    const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' },
        body: JSON.stringify({
            author,
            lifecycleState: 'PUBLISHED',
            specificContent: { 'com.linkedin.ugc.ShareContent': shareContent },
            visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
        }),
    });
    if (res.status === 201 || res.ok) {
        const id = res.headers.get('x-restli-id') || (await res.json().catch(() => ({})) as any)?.id || 'posted';
        return { ok: true, id: String(id) };
    }
    const data: any = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: data?.message || `LinkedIn API error (${res.status})` };
}

// registerUpload → PUT bytes → return the asset URN (or null → text-only).
async function uploadLinkedInImage(image: PostImage, token: string, owner: string): Promise<string | null> {
    const reg = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' },
        body: JSON.stringify({
            registerUploadRequest: {
                recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
                owner,
                serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
            },
        }),
    });
    const regData: any = await reg.json().catch(() => ({}));
    const asset: string | undefined = regData?.value?.asset;
    const uploadUrl: string | undefined =
        regData?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
    if (!asset || !uploadUrl) return null;

    const put = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': image.mimeType },
        body: await fetchImageBytes(image.url),
    });
    return put.ok ? asset : null;
}

// ── Failure handling (rate-limit defer / retry backoff / permanent fail) ──────
async function handleFailure(db: ReturnType<typeof getDb>, post: PostRow, reason: FailureReason, now: Date) {
    const attempt = post.attempt_count + 1;

    if (reason.httpStatus === 429) {
        const until = new Date(now.getTime() + 60 * 60 * 1000);
        await db.execute(
            `INSERT INTO rate_limit_states (organisation_id, platform, rate_limited_until, updated_at)
             VALUES (${post.organisation_id}, '${post.platform}', '${until.toISOString()}', now())
             ON CONFLICT (organisation_id, platform) DO UPDATE SET rate_limited_until = EXCLUDED.rate_limited_until, updated_at = now()`
        );
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${until.toISOString()}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        return;
    }

    if (!reason.isRetryable || attempt >= MAX_ATTEMPTS) {
        await db.execute(
            `UPDATE scheduled_posts SET status = 'failed', failure_reason = '${esc(JSON.stringify(reason))}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        await db.insert(notifications).values({
            userId: post.user_id,
            type: 'post_publish_failed',
            title: 'Post failed to publish',
            message: `Publishing to ${LABEL[post.platform]} failed: ${reason.errorMessage}`,
            metadata: { postId: post.id, platform: post.platform, reason },
        });
    } else {
        const retryAt = new Date(now.getTime() + (BACKOFF_MINS[attempt - 1] ?? 30) * 60 * 1000).toISOString();
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${retryAt}', attempt_count = ${attempt}, failure_reason = '${esc(JSON.stringify(reason))}', updated_at = now() WHERE id = ${post.id}`
        );
    }
}
