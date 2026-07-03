// netlify/functions/publish-facebook.ts
// Publish due Facebook Page posts every minute — closes the gap where 'facebook' posts were
// accepted/scheduled but had no publisher, so they sat at 'scheduled' on a past date forever.
//
// Facebook has no standalone connection in this app: it piggybacks on the org's Meta
// (Instagram) connection, which already stores the linked Page id (metadata.fbPageId) and a
// long-lived USER token carrying the pages_manage_posts scope. We derive a Page access token
// at publish time, then POST to /{pageId}/photos (when an image is attached) or /{pageId}/feed
// (text/link only). A future standalone 'facebook' connection is also honoured if present.
//
// Mirrors publish-social-posts' orchestration: claim FOR UPDATE SKIP LOCKED → 'publishing' →
// API call → 'published' | retry/backoff | 'failed'. Also reclaims rows orphaned in
// 'publishing' by a prior timed-out tick (self-healing).
//
// NOTE: the Graph API calls follow the documented contracts but have NOT been validated
// against a live Facebook Page — verify with a real connected Page.

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, systemConnections, publishCronLog, notifications } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { resolvePostImage, type PostImage } from '../../src/utils/social-publish';
import { recordPostedAssets } from '../../src/utils/pexels';

const BATCH = 100;
const BACKOFF_MINS = [2, 8, 30];
const MAX_ATTEMPTS = 3;
const GRAPH_VERSION = 'v19.0';
// A row left in 'publishing' longer than this was orphaned by a timed-out tick — reclaim it.
const STALE_PUBLISHING_MINS = 10;

type FailureReason = { httpStatus: number | null; errorMessage: string; isRetryable: boolean };
type PostRow = {
    id: number; user_id: number; organisation_id: number; caption: string | null;
    hashtags: string | null; connection_id: number | null; attempt_count: number;
    publish_date: string; content_asset_ids: unknown;
};
type DriverResult = { ok: true; id: string } | { ok: false; status: number | null; error: string };

const isRetryable = (s: number | null) => s === 429 || (s != null && s >= 500);
const esc = (s: string) => s.replace(/'/g, "''");

export const handler: Handler = async () => {
    const db = getDb();
    const tickStart = Date.now();
    const now = new Date();
    let processed = 0, succeeded = 0, failed = 0;

    // Self-heal: reclaim Facebook posts stranded in 'publishing' by an earlier timed-out tick.
    await db.execute(
        `UPDATE scheduled_posts SET status = 'scheduled', retry_at = NULL, updated_at = now()
         WHERE status = 'publishing' AND platform = 'facebook'
           AND updated_at < now() - interval '${STALE_PUBLISHING_MINS} minutes'`
    );

    const posts = await db.execute<PostRow>(
        `SELECT id, user_id, organisation_id, caption, hashtags, connection_id,
                attempt_count, publish_date, content_asset_ids
         FROM scheduled_posts
         WHERE status = 'scheduled'
           AND platform = 'facebook'
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

    await db.execute(
        `UPDATE scheduled_posts SET status = 'publishing', updated_at = now()
         WHERE id IN (${posts.map(p => p.id).join(',')})`
    );
    processed = posts.length;

    await Promise.allSettled(posts.map(async post => {
        try {
            const { pageId, pageToken } = await resolvePageCredentials(db, post);

            const text = [post.caption, post.hashtags].filter(Boolean).join('\n\n').trim();
            if (!text) throw new Error('Post has no text to publish.');

            // Attached image (best-effort — falls back to a text/link post if unresolvable).
            const image = await resolvePostImage(db, post.content_asset_ids).catch(() => null);

            const result = await publishFacebook(pageId, pageToken, text, image);

            if (!result.ok) {
                await handleFailure(db, post, { httpStatus: result.status, errorMessage: result.error, isRetryable: isRetryable(result.status) }, now);
                if (!isRetryable(result.status)) failed++;
                return;
            }

            await db.execute(
                `UPDATE scheduled_posts SET status = 'published', platform_post_id = '${esc(result.id)}', published_at = now(), updated_at = now() WHERE id = ${post.id}`
            );
            await recordPostedAssets(db, { orgId: post.organisation_id, userId: post.user_id, scheduledPostId: post.id })
                .catch(e => console.warn(`[publish-facebook] recordPostedAssets failed for post ${post.id}:`, e?.message || e));
            await db.insert(notifications).values({
                userId: post.user_id,
                type: 'post_published',
                title: 'Post published to Facebook',
                message: 'Your post has been published to Facebook.',
                metadata: { postId: post.id, platform: 'facebook', platformPostId: result.id },
            });
            succeeded++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[publish-facebook] post ${post.id} error:`, msg);
            await handleFailure(db, post, { httpStatus: null, errorMessage: msg, isRetryable: true }, now);
        }
    }));

    const durationMs = Date.now() - tickStart;
    await db.insert(publishCronLog).values({ postsProcessed: processed, postsSucceeded: succeeded, postsFailed: failed, durationMs });
    return { statusCode: 200, body: JSON.stringify({ processed, succeeded, failed, durationMs }) };
};

// Resolve the Page id + a Page access token for this post. Prefers a dedicated 'facebook'
// connection (future standalone FB OAuth) and otherwise falls back to the org's Meta
// (Instagram) connection, whose metadata carries the linked Page id and a user token with
// pages_manage_posts. Page tokens derived from a long-lived user token are themselves
// long-lived, so we derive on demand rather than persisting a separate secret.
async function resolvePageCredentials(db: ReturnType<typeof getDb>, post: PostRow): Promise<{ pageId: string; pageToken: string }> {
    // 1) Dedicated facebook connection, if one exists (by id on the post, else org-active).
    const fbWhere = post.connection_id
        ? eq(systemConnections.id, post.connection_id)
        : and(
            eq(systemConnections.organisationId, post.organisation_id),
            eq(systemConnections.serviceName, 'facebook'),
            eq(systemConnections.isActive, true),
          );
    const [fbConn] = await db.select({
        vaultRefKey: systemConnections.vaultRefKey,
        externalUserId: systemConnections.externalUserId,
        metadata: systemConnections.metadata,
    }).from(systemConnections).where(fbWhere).limit(1);

    if (fbConn?.vaultRefKey) {
        const secret = await getSecret(db, fbConn.vaultRefKey);
        const token = secret?.token as string | undefined;
        const pageId = fbConn.externalUserId || ((fbConn.metadata as any)?.fbPageId ?? null);
        if (token && pageId) {
            // A dedicated FB connection may already hold a Page token; if it's a user token,
            // deriving the page token is still correct (Graph returns the page token).
            const pageToken = await derivePageToken(token, pageId) ?? token;
            return { pageId, pageToken };
        }
    }

    // 2) Fall back to the org's Meta/Instagram connection (the only place a linked Page lives).
    const [meta] = await db.select({
        vaultRefKey: systemConnections.vaultRefKey,
        metadata: systemConnections.metadata,
    }).from(systemConnections).where(and(
        eq(systemConnections.organisationId, post.organisation_id),
        eq(systemConnections.serviceName, 'instagram'),
        eq(systemConnections.isActive, true),
    )).limit(1);

    const pageId = (meta?.metadata as any)?.fbPageId as string | undefined;
    if (!meta?.vaultRefKey || !pageId) {
        throw new Error('No connected Facebook Page for this post. Connect a Facebook Page (via the Meta integration) to publish.');
    }
    const secret = await getSecret(db, meta.vaultRefKey);
    const userToken = secret?.token as string | undefined;
    if (!userToken) throw new Error('No Meta token in vault for connection.');

    const pageToken = await derivePageToken(userToken, pageId);
    if (!pageToken) throw new Error('Could not obtain a Page access token from the Meta connection.');
    return { pageId, pageToken };
}

// GET /{pageId}?fields=access_token → the Page access token (requires pages_manage_posts).
async function derivePageToken(userToken: string, pageId: string): Promise<string | null> {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=access_token&access_token=${encodeURIComponent(userToken)}`);
    const data: any = await res.json().catch(() => ({}));
    return res.ok ? (data?.access_token ?? null) : null;
}

// Image → /{pageId}/photos (caption becomes the post text); text/link → /{pageId}/feed.
async function publishFacebook(pageId: string, pageToken: string, text: string, image: PostImage | null): Promise<DriverResult> {
    const endpoint = image
        ? `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`
        : `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`;
    const body: Record<string, string> = image
        ? { url: image.url, caption: text, access_token: pageToken }
        : { message: text, access_token: pageToken };

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    const id = data?.post_id || data?.id;
    if (res.ok && id) return { ok: true, id: String(id) };
    return { ok: false, status: res.status, error: data?.error?.message || `Facebook API error (${res.status})` };
}

// ── Failure handling (rate-limit defer / retry backoff / permanent fail) ──────
async function handleFailure(db: ReturnType<typeof getDb>, post: PostRow, reason: FailureReason, now: Date) {
    const attempt = post.attempt_count + 1;

    if (!reason.isRetryable || attempt >= MAX_ATTEMPTS) {
        await db.execute(
            `UPDATE scheduled_posts SET status = 'failed', failure_reason = '${esc(JSON.stringify(reason))}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        await db.insert(notifications).values({
            userId: post.user_id,
            type: 'post_publish_failed',
            title: 'Post failed to publish',
            message: `Publishing to Facebook failed: ${reason.errorMessage}`,
            metadata: { postId: post.id, platform: 'facebook', reason },
        });
    } else {
        const retryAt = new Date(now.getTime() + (BACKOFF_MINS[attempt - 1] ?? 30) * 60 * 1000).toISOString();
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${retryAt}', attempt_count = ${attempt}, failure_reason = '${esc(JSON.stringify(reason))}', updated_at = now() WHERE id = ${post.id}`
        );
    }
}
