// social-publish.ts — the shared social-publishing layer used by BOTH the cron publishers
// (publish-social-posts.ts for LinkedIn/X, publish-facebook.ts) and the self-test harness
// (social-publish-selftest.ts): image resolution, X token refresh, and the per-platform publish
// drivers themselves. Keeping the drivers here (not inline in the crons) is what lets the harness
// prove the real publish path rather than a copy of it.
//
// The API contracts were audited 2026-07-15 (see the driver section below); the self-test harness
// is the way to confirm them against a live connected account.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq, inArray } from 'drizzle-orm';
import { contentAssets, systemConnections } from '../../db/schema';
import { getSecret, storeSecret } from './vault';
import { getFreshAccessToken, IntegrationError, type IntegrationProvider } from './workspace-integrations';

function r2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID!,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
    });
}

export async function presignR2Get(key: string, expiresSec = 600): Promise<string> {
    return getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }), { expiresIn: expiresSec });
}

// Resolve a displayable URL for a stored asset: S3 uploads already carry a public
// storageUrl; AI-generated images live in the private R2 bucket with only a storageKey,
// so presign a short-lived GET URL; mock/dev assets (Pexels/picsum hotlinks) fall back
// to externalUrl. Used anywhere an asset needs to be shown in the UI (not just publishing).
//
// `audio` belongs on the presign path, not off it. content-upload-url returns only
// { uploadUrl, storageKey } — never a storageUrl — so every library upload reaches here with
// storageUrl null and depends on the presign below. A type left out of this list resolves to
// externalUrl, which an uploaded file doesn't have: the caller gets null and the media silently
// never plays. `link` stays out because externalUrl IS its content.
export async function resolveAssetDisplayUrl(asset: {
    assetType?: string | null;
    storageUrl?: string | null;
    storageKey?: string | null;
    externalUrl?: string | null;
}): Promise<string | null> {
    if (asset.storageUrl) return asset.storageUrl;
    const isStored = asset.assetType === 'image' || asset.assetType === 'video' || asset.assetType === 'audio';
    if (!isStored) return asset.externalUrl || null;
    if (asset.storageKey) {
        try { return await presignR2Get(asset.storageKey); } catch { /* fall through to externalUrl */ }
    }
    return asset.externalUrl || null;
}

export interface PostImage { url: string; mimeType: string; }

// First image asset attached to the post → a fetchable URL (presigned R2 or external).
// Returns null for text-only posts (caller falls back to a text post).
export async function resolvePostImage(db: any, contentAssetIds: unknown): Promise<PostImage | null> {
    const ids = Array.isArray(contentAssetIds)
        ? contentAssetIds.map(Number).filter(Number.isFinite)
        : [];
    if (!ids.length) return null;

    const rows = await db.select({
        assetType:  contentAssets.assetType,
        mimeType:   contentAssets.mimeType,
        storageKey: contentAssets.storageKey,
        externalUrl: contentAssets.externalUrl,
    }).from(contentAssets).where(inArray(contentAssets.id, ids));

    const img = rows.find((r: any) => (r.assetType ?? '').toLowerCase() === 'image' && (r.storageKey || r.externalUrl));
    if (!img) return null;
    const mimeType = img.mimeType || 'image/jpeg';
    if (img.storageKey) {
        try { return { url: await presignR2Get(img.storageKey), mimeType }; } catch { /* fall through to external */ }
    }
    if (img.externalUrl) return { url: img.externalUrl, mimeType };
    return null;
}

export interface PostVideo { url: string; mimeType: string; }

// First VIDEO asset attached to the post → a fetchable URL (presigned R2 or external).
// Returns null when the post carries no video, which for YouTube is a hard publish failure
// rather than a fall-back-to-text case (see resolvePostImage for the image equivalent).
export async function resolvePostVideo(db: any, contentAssetIds: unknown): Promise<PostVideo | null> {
    const ids = Array.isArray(contentAssetIds)
        ? contentAssetIds.map(Number).filter(Number.isFinite)
        : [];
    if (!ids.length) return null;

    const rows = await db.select({
        assetType:  contentAssets.assetType,
        mimeType:   contentAssets.mimeType,
        storageKey: contentAssets.storageKey,
        externalUrl: contentAssets.externalUrl,
    }).from(contentAssets).where(inArray(contentAssets.id, ids));

    const vid = rows.find((r: any) => (r.assetType ?? '').toLowerCase() === 'video' && (r.storageKey || r.externalUrl));
    if (!vid) return null;
    const mimeType = vid.mimeType || 'video/mp4';
    if (vid.storageKey) {
        // Longer TTL than the image presign: YouTube's resumable upload streams the whole file,
        // and a large video can outlive a 10-minute URL mid-transfer.
        try { return { url: await presignR2Get(vid.storageKey, 3600), mimeType }; } catch { /* fall through */ }
    }
    if (vid.externalUrl) return { url: vid.externalUrl, mimeType };
    return null;
}

// Refresh an X OAuth2 access token from the stored refresh token; persists and returns
// the new token, or null if refresh isn't possible (no creds / no refresh token / error).
export async function refreshXToken(db: any, vaultRefKey: string): Promise<string | null> {
    const clientId = process.env.X_CLIENT_ID, clientSecret = process.env.X_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const secret = await getSecret(db, vaultRefKey).catch(() => null) as { token?: string; refreshToken?: string } | null;
    const refreshToken = secret?.refreshToken;
    if (!refreshToken) return null;

    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) return null;
    // X rotates refresh tokens — persist the new one (fall back to the old if absent).
    await storeSecret(db, vaultRefKey, { token: data.access_token, refreshToken: data.refresh_token ?? refreshToken });
    return data.access_token as string;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Credential resolution across BOTH connection stores.
//
// Social platforms are split over two tables for historical reasons:
//   • system_connections     — Facebook/Instagram/LinkedIn/X. Per-assistant (has assistantId),
//                              token in vault under the row's own vaultRefKey.
//   • workspace_integrations — Threads/YouTube (and the non-social connectors). Org-wide, one row
//                              per (org, provider), refreshed by getFreshAccessToken().
//
// Rather than migrate the live publishers or duplicate OAuth into social-oauth-init, the publish
// path resolves through here and reads from whichever store holds the platform. Callers get one
// shape and never need to know which side answered.
//
// Per-assistant scoping for a workspace-backed platform works via a SHADOW ROW in
// system_connections: same serviceName, but vaultRefKey NULL. It carries the assistantId/isActive
// toggle and nothing else — token material is never copied between stores. A null vaultRefKey is
// therefore not an error here (it is in the legacy path), it is the signal to fall through to
// workspace_integrations.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Platforms whose tokens live in workspace_integrations rather than system_connections. */
export const WORKSPACE_BACKED_PLATFORMS = new Set<string>(['threads', 'youtube']);

export interface SocialCredentials {
    token: string;
    /** Platform-side account id: system_connections.externalUserId, or the workspace row's tenantId. */
    externalUserId: string | null;
    /** The system_connections row id when one exists (including a shadow row), else null. */
    connectionId: number | null;
    /**
     * Retry-once refresh for drivers that surface a 401. Null when the token is fresh by
     * construction (workspace-backed platforms refresh proactively inside getFreshAccessToken).
     */
    refresh: (() => Promise<string | null>) | null;
}

/** The system_connections row shape the routing decision depends on. */
export interface ConnectionRow {
    id: number;
    vaultRefKey: string | null;
    externalUserId: string | null;
}

export type CredentialSource =
    | { store: 'system_connections'; vaultRefKey: string; connectionId: number; externalUserId: string | null }
    | { store: 'workspace_integrations'; connectionId: number | null }
    | { store: 'none' };

/**
 * Which store holds this platform's token — the pure routing decision behind
 * resolveSocialCredentials, split out so the branch logic is testable without a live DB
 * (getSecret decrypts for real, so a faked one proves nothing).
 *
 * A row WITH a vaultRefKey owns its token → system_connections. A missing row, or a shadow row
 * (vaultRefKey NULL, carrying only the per-assistant toggle), routes to workspace_integrations —
 * but only for platforms actually backed there, so a genuinely missing Facebook connection still
 * fails with its own message instead of a misleading "connect it on the Integrations page".
 */
export function chooseCredentialSource(platform: string, conn: ConnectionRow | undefined | null): CredentialSource {
    if (conn?.vaultRefKey) {
        return {
            store: 'system_connections',
            vaultRefKey: conn.vaultRefKey,
            connectionId: conn.id,
            externalUserId: conn.externalUserId ?? null,
        };
    }
    if (WORKSPACE_BACKED_PLATFORMS.has(platform)) {
        return { store: 'workspace_integrations', connectionId: conn?.id ?? null };
    }
    return { store: 'none' };
}

export async function resolveSocialCredentials(
    db: any,
    opts: { organisationId: number; platform: string; connectionId?: number | null },
): Promise<SocialCredentials> {
    const { organisationId, platform } = opts;

    const connWhere = opts.connectionId
        ? eq(systemConnections.id, opts.connectionId)
        : and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.serviceName, platform),
            eq(systemConnections.isActive, true),
          );
    const [conn] = await db.select({
        id: systemConnections.id,
        vaultRefKey: systemConnections.vaultRefKey,
        externalUserId: systemConnections.externalUserId,
    }).from(systemConnections).where(connWhere).limit(1);

    const source = chooseCredentialSource(platform, conn);

    if (source.store === 'system_connections') {
        const secret = await getSecret(db, source.vaultRefKey);
        const token = secret?.token as string | undefined;
        if (!token) throw new Error('No token in vault for connection.');
        const { vaultRefKey } = source;
        return {
            token,
            externalUserId: source.externalUserId,
            connectionId: source.connectionId,
            refresh: platform === 'x' ? () => refreshXToken(db, vaultRefKey) : null,
        };
    }

    if (source.store === 'workspace_integrations') {
        try {
            const fresh = await getFreshAccessToken(db, organisationId, platform as IntegrationProvider);
            return {
                token: fresh.accessToken,
                externalUserId: fresh.tenantId,
                connectionId: source.connectionId,
                refresh: null,
            };
        } catch (err) {
            // Surface the provider-accurate message ("connect it on the Integrations page",
            // "please reconnect") rather than flattening it to a generic publish failure.
            if (err instanceof IntegrationError) throw new Error(err.message);
            throw err;
        }
    }

    throw new Error(`No active ${platform} connection for this post.`);
}

// Fetch image bytes from a (presigned/external) URL as an ArrayBuffer (a valid fetch body).
export async function fetchImageBytes(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch media (${res.status})`);
    return res.arrayBuffer();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Platform publish drivers. Extracted here so BOTH the cron publishers (publish-social-posts.ts,
// publish-facebook.ts) and the self-test harness (social-publish-selftest.ts) run the exact same
// code — a green self-test then proves the real publish path, not a parallel copy of it.
//
// AUDIT (2026-07-15): API contracts reviewed against current platform docs. Endpoints/versions were
// modernized where the change is unambiguous (Graph version, X host). Anything that couldn't be
// confirmed without a live connected account is flagged and is exactly what the harness exercises.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type DriverResult = { ok: true; id: string } | { ok: false; status: number | null; error: string };

export const X_MAX = 280;
export const FB_GRAPH_VERSION = 'v21.0';   // was v19.0 — bumped to a current stable Graph version.
const isDriverRetryable = (s: number | null) => s === 429 || (s != null && s >= 500);
export { isDriverRetryable };

// ── X (Twitter) ────────────────────────────────────────────────────────────────────────────────
// Tweet creation: POST /2/tweets (unchanged contract). Media upload: the v1.1 upload.twitter.com
// endpoint is superseded by /2/media/upload on api.x.com; we use the v2 endpoint and fall back to a
// text-only tweet if media upload fails (best-effort media has always been the behaviour). Host
// canonicalised to api.x.com (api.twitter.com still resolves, but x.com is the documented host).
export async function publishX(text: string, token: string, image: PostImage | null): Promise<DriverResult> {
    let mediaId: string | null = null;
    if (image) { try { mediaId = await uploadXMedia(image, token); } catch { /* text-only on media failure */ } }

    const body: Record<string, unknown> = { text: text.slice(0, X_MAX) };
    if (mediaId) body.media = { media_ids: [mediaId] };

    const res = await fetch('https://api.x.com/2/tweets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.data?.id) return { ok: true, id: String(data.data.id) };
    return { ok: false, status: res.status, error: data?.detail || data?.title || `X API error (${res.status})` };
}

// Upload media to X via the v2 endpoint (multipart form-data). Returns the media id or null (→ text-only).
async function uploadXMedia(image: PostImage, token: string): Promise<string | null> {
    const bytes = await fetchImageBytes(image.url);
    const form = new FormData();
    form.append('media', new Blob([bytes], { type: image.mimeType || 'image/jpeg' }));
    form.append('media_category', 'tweet_image');
    const res = await fetch('https://api.x.com/2/media/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },   // let fetch set the multipart boundary
        body: form,
    });
    const data: any = await res.json().catch(() => ({}));
    // v2 returns { data: { id } }; tolerate the legacy media_id_string shape too.
    return res.ok ? (data?.data?.id ?? data?.media_id_string ?? null) : null;
}

// Read the authenticated X user (read-only preflight for the harness).
export async function fetchXIdentity(token: string): Promise<DriverResult> {
    const res = await fetch('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.data?.id) return { ok: true, id: `@${data.data.username || data.data.id}` };
    return { ok: false, status: res.status, error: data?.detail || data?.title || `X API error (${res.status})` };
}

// ── LinkedIn ─────────────────────────────────────────────────────────────────────────────────────
// AUDIT: /v2/ugcPosts + /v2/assets registerUpload is the legacy Share API; it still works for apps
// with the w_member_social scope (which this app uses). The modern equivalent is the versioned
// /rest/posts + /rest/images API, which requires the "Community Management" product and a
// LinkedIn-Version header — a scope/product change, not a drop-in swap. Left on ugcPosts and flagged
// for the harness; migration tracked separately.
export async function publishLinkedIn(text: string, token: string, authorId: string | null, image: PostImage | null): Promise<DriverResult> {
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

// Resolve the member's author URN via OpenID userinfo (preferred; needs the 'openid'/'profile'
// scope) then the legacy /v2/me. Returns a urn:li:person:… string, or an error for the harness.
export async function resolveLinkedInAuthor(token: string): Promise<{ ok: true; urn: string } | { ok: false; status: number | null; error: string }> {
    const info = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    if (info.ok) {
        const d: any = await info.json().catch(() => ({}));
        if (d?.sub) return { ok: true, urn: `urn:li:person:${d.sub}` };
    }
    const me = await fetch('https://api.linkedin.com/v2/me', { headers: { Authorization: `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' } });
    const md: any = await me.json().catch(() => ({}));
    if (me.ok && md?.id) return { ok: true, urn: `urn:li:person:${md.id}` };
    return { ok: false, status: me.status, error: md?.message || `LinkedIn identity error (${me.status})` };
}

// ── Threads ───────────────────────────────────────────────────────────────────────────────────────
// Two-step publish, same shape as Instagram: create a media container, then publish it by id.
// Text-first — media_type TEXT unless the draft carries an image, in which case Threads fetches
// image_url ITSELF (so the URL must be publicly reachable; a presigned R2 GET qualifies).
//
// Shared with sync-action.ts's threads_create_post handler so the chat-driven path and the
// scheduled-publish path cannot drift apart.

export const THREADS_TEXT_MAX = 500;

export async function publishThreads(
    text: string,
    token: string,
    threadsUserId: string | null,
    image: PostImage | null,
): Promise<DriverResult> {
    // tenantId carries the Threads user id captured at connect time; 'me' is the documented
    // fallback and resolves to the token's owner.
    const uid = encodeURIComponent(threadsUserId || 'me');
    const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' };
    const body = text.slice(0, THREADS_TEXT_MAX);

    // 1. Create the container.
    const containerParams = new URLSearchParams({ media_type: image ? 'IMAGE' : 'TEXT', text: body });
    if (image) containerParams.set('image_url', image.url);
    const containerRes = await fetch(`https://graph.threads.net/v1.0/${uid}/threads`, {
        method: 'POST', headers: authHeaders, body: containerParams,
    });
    const containerData: any = await containerRes.json().catch(() => ({}));
    if (!containerRes.ok || !containerData?.id) {
        return { ok: false, status: containerRes.status, error: containerData?.error?.message || `Threads container error (${containerRes.status})` };
    }

    // 2. Publish it.
    const publishRes = await fetch(`https://graph.threads.net/v1.0/${uid}/threads_publish`, {
        method: 'POST', headers: authHeaders, body: new URLSearchParams({ creation_id: String(containerData.id) }),
    });
    const publishData: any = await publishRes.json().catch(() => ({}));
    if (!publishRes.ok || !publishData?.id) {
        return { ok: false, status: publishRes.status, error: publishData?.error?.message || `Threads publish error (${publishRes.status})` };
    }
    return { ok: true, id: String(publishData.id) };
}

// ── YouTube ───────────────────────────────────────────────────────────────────────────────────────
// Resumable upload: POST the snippet/status metadata to open a session, then PUT the bytes to the
// session URL returned in the Location header.
//
// Shared with sync-action.ts's youtube_upload_video handler.
//
// The bytes go up in fixed-size chunks with Content-Range, each pulled from the source with its own
// ranged GET, so peak memory is one chunk rather than the whole file. YouTube answers every
// non-final chunk with 308 + a `Range` header naming the last byte it actually stored; we resume
// from THAT offset rather than assuming our own, which is what makes a retried chunk safe.
//
// (This replaced a single buffered PUT — Buffer.from(await res.arrayBuffer()) — whose ceiling was
// whatever the function's memory allowed. Fine for short marketing clips, fatal for long-form.)
//
// Wall clock is handled separately: pass `deadlineMs` and the loop stops at a chunk boundary,
// returning `incomplete` state that a later invocation feeds back as `resume`. See
// publish-youtube-background.ts. Without a deadline the call runs to completion as before.

export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;

export interface YouTubeMeta {
    title: string;
    description: string;
    tags: string[];
    /** 'shorts' appends the #Shorts marker YouTube uses to classify the upload. */
    format?: string;
}

/**
 * Split a composer caption into a YouTube title + description. The composer has one caption
 * field, so the first non-empty line becomes the title (capped at 100) and the whole caption
 * becomes the description — the same convention creators use when cross-posting.
 */
export function youtubeMetaFromCaption(caption: string, hashtags: string, format?: string): YouTubeMeta {
    const text = (caption || '').trim();
    const firstLine = text.split('\n').map(l => l.trim()).find(Boolean) || 'New video';
    let title = firstLine.slice(0, YOUTUBE_TITLE_MAX);
    if (String(format ?? '').toLowerCase() === 'shorts' && !/#shorts/i.test(title)) {
        title = `${title.slice(0, YOUTUBE_TITLE_MAX - 8)} #Shorts`.trim();
    }
    const description = [text, hashtags].filter(Boolean).join('\n\n').slice(0, YOUTUBE_DESCRIPTION_MAX);
    const tags = (hashtags || '').split(/[\s,]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean).slice(0, 30);
    return { title, description, tags, format };
}

// Google requires every non-final chunk to be a multiple of 256 KiB.
const YT_CHUNK_MULTIPLE = 256 * 1024;
export const YT_CHUNK_SIZE = 8 * 1024 * 1024;   // 8 MiB — peak memory per chunk.
const YT_CHUNK_ATTEMPTS = 4;                    // per-chunk retries before giving up.
// Leave room for one more source GET + PUT round trip before the runtime kills us. Stopping a chunk
// short of the deadline costs one extra invocation; overrunning loses the whole tick's work.
const YT_DEADLINE_MARGIN_MS = 20_000;

/**
 * Enough to continue an upload in a LATER function invocation. YouTube keeps a resumable session
 * alive for about a week, so this survives comfortably between cron ticks.
 *
 * `offset` is advisory — a resume always re-queries the session for the authoritative offset before
 * sending anything, because the previous invocation may have been killed after YouTube stored a
 * chunk but before we recorded it.
 */
export interface YouTubeResumeState {
    uploadUrl: string;
    total: number;
    offset: number;
}

export type YouTubeOutcome =
    | { kind: 'done'; id: string }
    | { kind: 'incomplete'; state: YouTubeResumeState }
    | { kind: 'failed'; status: number | null; error: string };

export interface YouTubePublishOpts {
    chunkSize?: number;
    /** Absolute epoch-ms wall-clock budget; the loop stops cleanly at a chunk boundary before it. */
    deadlineMs?: number;
    /** Continue a session opened by an earlier invocation (from a previous `incomplete`). */
    resume?: YouTubeResumeState;
}

// What the source URL can support. A presigned R2 GET honours Range and reports a length, which is
// the path that gets true chunking + resume; anything else gets a single streamed PUT, which still
// avoids buffering but cannot resume.
async function probeVideoSource(url: string): Promise<{ size: number | null; rangeSupported: boolean; contentType: string; reachable: boolean }> {
    // A ranged GET is the honest probe: HEAD is often unsupported on object stores, and a 206 proves
    // Range works rather than trusting an Accept-Ranges advertisement.
    try {
        const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
        const contentType = res.headers.get('content-type') || 'video/mp4';
        if (res.status === 206) {
            // Content-Range: bytes 0-0/12345 — the total is the only trustworthy size here.
            const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
            await res.body?.cancel().catch(() => { /* already drained */ });
            if (total) return { size: Number(total), rangeSupported: true, contentType, reachable: true };
        }
        await res.body?.cancel().catch(() => { /* already drained */ });
        // 200 means Range was ignored and we were handed the whole file — don't chunk against it.
        const len = res.headers.get('content-length');
        return {
            size: res.status === 200 && len ? Number(len) : null,
            rangeSupported: false,
            contentType,
            reachable: res.ok || res.status === 206,
        };
    } catch {
        return { size: null, rangeSupported: false, contentType: 'video/mp4', reachable: false };
    }
}

// Ask the session where it actually is. Used on resume, and after a failed chunk, so we continue
// from YouTube's offset rather than replaying bytes it already holds.
async function queryYouTubeOffset(uploadUrl: string, total: number): Promise<number | null> {
    const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' },
    });
    // null means "the session is gone" — reserved for an HTTP failure. A live session that has
    // stored NOTHING yet answers 308 with no Range header at all, which is offset 0, not death.
    // Conflating the two aborts every upload interrupted before its first chunk landed.
    if (res.status !== 308 && res.status !== 200 && res.status !== 201) return null;
    return parseYouTubeOffset(res.headers.get('range')) ?? 0;
}

// `Range: bytes=0-262143` → the next byte to send (262144). Absent header means nothing stored yet.
function parseYouTubeOffset(header: string | null): number | null {
    const end = /bytes=0-(\d+)/.exec(header ?? '')?.[1];
    return end == null ? null : Number(end) + 1;
}

/**
 * Upload a video over YouTube's resumable protocol, chunked so peak memory is one chunk.
 *
 * Returns `incomplete` when a `deadlineMs` is set and the wall clock runs out mid-upload; feed that
 * state back as `opts.resume` later to carry on. Without a deadline it runs to completion.
 */
export async function publishYouTubeResumable(
    meta: YouTubeMeta,
    token: string,
    video: PostVideo | null,
    opts: YouTubePublishOpts = {},
): Promise<YouTubeOutcome> {
    if (!video) return { kind: 'failed', status: null, error: 'YouTube posts require a video — attach one before publishing.' };

    // Resuming: the session already exists, so skip the probe + init and go straight back to the
    // bytes. Re-query for the true offset first — the invocation that produced this state may have
    // been killed after YouTube stored a chunk but before the write landed.
    if (opts.resume) {
        const { uploadUrl, total } = opts.resume;
        const confirmed = await queryYouTubeOffset(uploadUrl, total);
        if (confirmed == null) {
            return { kind: 'failed', status: null, error: 'The YouTube upload session expired before the video finished. It will start over.' };
        }
        if (confirmed >= total) {
            return { kind: 'failed', status: null, error: 'YouTube has the whole video but did not confirm it. Check the channel before retrying.' };
        }
        return uploadYouTubeChunked(uploadUrl, video.url, total, opts.chunkSize ?? YT_CHUNK_SIZE, opts.deadlineMs, confirmed);
    }

    // 1. Probe the source FIRST — its size and media type belong on the session-open request, and a
    // dead source should fail before we book a session against the channel's daily upload quota.
    const probe = await probeVideoSource(video.url);
    if (!probe.reachable) {
        return { kind: 'failed', status: null, error: 'Could not fetch the video from storage — re-attach it and try again.' };
    }

    // 2. Open the resumable session with the SEO metadata. X-Upload-Content-* describe the MEDIA;
    // this request's own Content-Type describes the metadata JSON in the body.
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': video.mimeType || probe.contentType,
            ...(probe.size ? { 'X-Upload-Content-Length': String(probe.size) } : {}),
        },
        body: JSON.stringify({
            snippet: {
                title: meta.title.slice(0, YOUTUBE_TITLE_MAX),
                description: meta.description.slice(0, YOUTUBE_DESCRIPTION_MAX),
                tags: meta.tags.slice(0, 30),
                categoryId: '22', // People & Blogs (safe default)
            },
            status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        }),
    });
    const uploadUrl = initRes.headers.get('location');
    if (!initRes.ok || !uploadUrl) {
        const err: any = await initRes.json().catch(() => ({}));
        return { kind: 'failed', status: initRes.status, error: err?.error?.message || `YouTube upload session error (${initRes.status})` };
    }

    // 3. Send the bytes.
    return probe.rangeSupported && probe.size && probe.size > 0
        ? uploadYouTubeChunked(uploadUrl, video.url, probe.size, opts.chunkSize ?? YT_CHUNK_SIZE, opts.deadlineMs, 0)
        : uploadYouTubeStreamed(uploadUrl, video.url, probe.size, video.mimeType || probe.contentType);
}

// Chunked + resumable. Peak memory is one chunk.
async function uploadYouTubeChunked(
    uploadUrl: string,
    videoUrl: string,
    total: number,
    rawChunkSize: number,
    deadlineMs: number | undefined,
    startOffset: number,
): Promise<YouTubeOutcome> {
    // Round down to a 256 KiB boundary; never below one multiple.
    const chunkSize = Math.max(YT_CHUNK_MULTIPLE, Math.floor(rawChunkSize / YT_CHUNK_MULTIPLE) * YT_CHUNK_MULTIPLE);
    let offset = startOffset;
    let attempts = 0;

    while (offset < total) {
        // Stop at a chunk boundary while there's still time to hand back clean state. Being killed
        // mid-chunk instead would lose the session URL and restart the whole video from zero.
        if (deadlineMs != null && Date.now() + YT_DEADLINE_MARGIN_MS >= deadlineMs) {
            return { kind: 'incomplete', state: { uploadUrl, total, offset } };
        }

        const end = Math.min(offset + chunkSize, total) - 1;

        // Pull just this window from the source. `chunk` is the only video data we ever hold.
        const srcRes = await fetch(videoUrl, { headers: { Range: `bytes=${offset}-${end}` } });
        if (srcRes.status !== 206 && srcRes.status !== 200) {
            return { kind: 'failed', status: srcRes.status, error: 'Could not fetch the video from storage — re-attach it and try again.' };
        }
        const chunk = Buffer.from(await srcRes.arrayBuffer());
        if (chunk.byteLength === 0) {
            return { kind: 'failed', status: null, error: 'The video source returned no bytes for the requested range.' };
        }
        // A source that ignored Range hands back more than we asked for; trim so Content-Range stays honest.
        const body = chunk.byteLength > end - offset + 1 ? chunk.subarray(0, end - offset + 1) : chunk;
        const last = offset + body.byteLength - 1;

        const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Range': `bytes ${offset}-${last}/${total}`,
                'Content-Length': String(body.byteLength),
            },
            body,
        });

        // Terminal success — the final chunk carries the video resource.
        if (putRes.status === 200 || putRes.status === 201) {
            const data: any = await putRes.json().catch(() => ({}));
            if (data?.id) return { kind: 'done', id: String(data.id) };
            return { kind: 'failed', status: putRes.status, error: data?.error?.message || 'YouTube accepted the upload but returned no video id.' };
        }

        // Incomplete — advance to the offset YouTube reports it actually stored.
        if (putRes.status === 308) {
            const confirmed = parseYouTubeOffset(putRes.headers.get('range'));
            const next = confirmed ?? last + 1;
            // A 308 that doesn't move the offset would spin this loop forever (and a serverless
            // function has no one to notice). Treat stalled progress like a transient failure.
            if (next <= offset) {
                if (++attempts >= YT_CHUNK_ATTEMPTS) {
                    return { kind: 'failed', status: 308, error: 'YouTube stopped accepting the upload part-way through. Try again.' };
                }
                continue;
            }
            attempts = 0;
            offset = next;
            continue;
        }

        // Transient — re-sync against the session and retry the same window.
        if (isDriverRetryable(putRes.status) && ++attempts < YT_CHUNK_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 500 * 2 ** (attempts - 1)));
            const confirmed = await queryYouTubeOffset(uploadUrl, total);
            if (confirmed != null) offset = confirmed;
            continue;
        }

        const data: any = await putRes.json().catch(() => ({}));
        return { kind: 'failed', status: putRes.status, error: data?.error?.message || `YouTube upload error (${putRes.status})` };
    }

    // Loop drained without a terminal 200/201: YouTube has every byte but never returned the resource.
    return { kind: 'failed', status: null, error: 'YouTube received the whole video but did not confirm it. Check the channel before retrying.' };
}

// Fallback for sources that won't serve ranges: stream the body straight through in one PUT. Still
// no full-file buffer, but a failure restarts from zero — nothing to resume against.
async function uploadYouTubeStreamed(
    uploadUrl: string,
    videoUrl: string,
    size: number | null,
    contentType: string,
): Promise<YouTubeOutcome> {
    const srcRes = await fetch(videoUrl);
    if (!srcRes.ok || !srcRes.body) {
        return { kind: 'failed', status: srcRes.status, error: 'Could not fetch the video from storage — re-attach it and try again.' };
    }

    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (size) headers['Content-Length'] = String(size);

    const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        body: srcRes.body,
        // Node streams a request body only in half-duplex mode; without this fetch rejects a stream body.
        duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const data: any = await putRes.json().catch(() => ({}));
    if (putRes.ok && data?.id) return { kind: 'done', id: String(data.id) };
    return { kind: 'failed', status: putRes.status, error: data?.error?.message || `YouTube upload error (${putRes.status})` };
}

/**
 * Run-to-completion wrapper for callers with no wall-clock budget (the cron's inline path and
 * sync-action's chat handler). Flattens to the DriverResult every other driver returns; an
 * `incomplete` here would mean a deadline was passed, which this signature can't express.
 */
export async function publishYouTube(meta: YouTubeMeta, token: string, video: PostVideo | null): Promise<DriverResult> {
    const outcome = await publishYouTubeResumable(meta, token, video);
    if (outcome.kind === 'done') return { ok: true, id: outcome.id };
    if (outcome.kind === 'failed') return { ok: false, status: outcome.status, error: outcome.error };
    return { ok: false, status: null, error: 'The upload ran out of time before finishing.' };
}

// ── Facebook (Graph API) ──────────────────────────────────────────────────────────────────────────
// Image → /{pageId}/photos (caption becomes the post text); text/link → /{pageId}/feed.
export async function publishFacebook(pageId: string, pageToken: string, text: string, image: PostImage | null): Promise<DriverResult> {
    const endpoint = image
        ? `https://graph.facebook.com/${FB_GRAPH_VERSION}/${pageId}/photos`
        : `https://graph.facebook.com/${FB_GRAPH_VERSION}/${pageId}/feed`;
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

// GET /{pageId}?fields=access_token → the Page access token (requires pages_manage_posts).
export async function derivePageToken(userToken: string, pageId: string): Promise<string | null> {
    const res = await fetch(`https://graph.facebook.com/${FB_GRAPH_VERSION}/${pageId}?fields=access_token&access_token=${encodeURIComponent(userToken)}`);
    const data: any = await res.json().catch(() => ({}));
    return res.ok ? (data?.access_token ?? null) : null;
}

// Resolve a Page id + Page access token for an org. Prefers a dedicated 'facebook' connection and
// otherwise falls back to the org's Meta (Instagram) connection, whose metadata carries the linked
// Page id and a user token with pages_manage_posts. Shared by the FB publisher and the harness.
export async function resolveFacebookPageCredentials(
    db: any,
    args: { organisationId: number; connectionId?: number | null },
): Promise<{ pageId: string; pageToken: string }> {
    // 1) Dedicated facebook connection, if one exists (by id, else org-active).
    const fbWhere = args.connectionId
        ? eq(systemConnections.id, args.connectionId)
        : and(
            eq(systemConnections.organisationId, args.organisationId),
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
            const pageToken = await derivePageToken(token, pageId) ?? token;
            return { pageId, pageToken };
        }
    }

    // 2) Fall back to the org's Meta/Instagram connection (the only place a linked Page lives).
    const [meta] = await db.select({
        vaultRefKey: systemConnections.vaultRefKey,
        metadata: systemConnections.metadata,
    }).from(systemConnections).where(and(
        eq(systemConnections.organisationId, args.organisationId),
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
