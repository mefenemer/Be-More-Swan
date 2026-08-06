// netlify/functions/social-publish-selftest.ts
// Publisher self-test harness (US-SMM #4 verification). Proves the Facebook / LinkedIn / X publish
// path against a REAL connected account, using the exact same drivers the cron publishers use
// (src/utils/social-publish.ts) — so a green result here means the live publish path works, not a
// parallel copy of it.
//
// POST { platform, connectionId?, confirmTestPost? }
//   • Default (confirmTestPost falsy): read-only PREFLIGHT — resolves the org's live connection +
//     vault token and calls a read-only identity/credential endpoint. Publishes nothing.
//   • confirmTestPost === true: sends ONE clearly-marked text-only test post through the real driver
//     and returns the platform post id + a hint on how to delete it. Gated to org owners/admins.
//
// Tenant-scoped (requireTenant): operates only on the caller's own organisation's connections.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { requireTenant } from '../../src/utils/tenant';
import {
    fetchXIdentity, resolveLinkedInAuthor, resolveFacebookPageCredentials, fetchYouTubeIdentity,
    fetchThreadsIdentity, resolveSocialCredentials, publishX, publishLinkedIn, publishFacebook,
    publishYouTube, publishThreads, refreshXToken, type DriverResult,
} from '../../src/utils/social-publish';
import { withLambda } from '@netlify/aws-lambda-compat';

const PLATFORMS = ['facebook', 'linkedin', 'x', 'threads', 'youtube'] as const;
type SelfTestPlatform = typeof PLATFORMS[number];

const LABEL: Record<SelfTestPlatform, string> = { facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X (Twitter)', threads: 'Threads', youtube: 'YouTube' };

// A test post that is unmistakably a diagnostic, timestamped so repeated runs stay unique.
function testMessage(): string {
    return `✅ Be More Swan publisher self-test — please ignore/delete. ${new Date().toISOString()}`;
}

// How to remove the test post afterwards, per platform (surfaced to the user; we never auto-delete).
function deleteHint(platform: SelfTestPlatform, id: string): string {
    if (platform === 'youtube') return `Delete the video from YouTube Studio (video id ${id}) — it was uploaded PRIVATE.`;
    // Threads has no private/draft mode: a test post is PUBLIC the moment it publishes, so this
    // hint matters more here than anywhere else.
    if (platform === 'threads') return `Delete the post from your Threads profile (post id ${id}) — it published PUBLICLY.`;
    if (platform === 'x') return `Delete the tweet from your X account (post id ${id}).`;
    if (platform === 'linkedin') return `Delete the post from your LinkedIn feed (urn ${id}).`;
    return `Delete the post from your Facebook Page (post id ${id}).`;
}

// Resolve the org's active connection row (vault key + external id) for a platform.
async function resolveConnection(db: ReturnType<typeof getDb>, orgId: number, platform: string, connectionId?: number) {
    const where = connectionId
        ? and(eq(systemConnections.id, connectionId), eq(systemConnections.organisationId, orgId))
        : and(
            eq(systemConnections.organisationId, orgId),
            eq(systemConnections.serviceName, platform),
            eq(systemConnections.isActive, true),
            eq(systemConnections.status, 'active'),
          );
    const [conn] = await db.select({
        id: systemConnections.id,
        vaultRefKey: systemConnections.vaultRefKey,
        externalUserId: systemConnections.externalUserId,
    }).from(systemConnections).where(where).limit(1);
    return conn ?? null;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId, role } = ctx;

    let body: { platform?: string; connectionId?: number; confirmTestPost?: boolean; videoUrl?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const platform = String(body.platform || '') as SelfTestPlatform;
    if (!PLATFORMS.includes(platform)) {
        return { statusCode: 400, body: JSON.stringify({ error: `platform must be one of: ${PLATFORMS.join(', ')}` }) };
    }
    const wantTestPost = body.confirmTestPost === true;

    // Sending a real post is owner/admin-only; the read-only preflight is open to any member.
    if (wantTestPost && !['owner', 'admin'].includes(role)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Only an organisation owner or admin can send a live test post.' }) };
    }

    const json = (status: number, payload: Record<string, unknown>) =>
        ({ statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform, label: LABEL[platform], ...payload }) });

    try {
        // ── YouTube: verify the channel, then optionally run a REAL chunked upload. ──
        // This is the only way to exercise the resumable protocol against the live API: real
        // Content-Range handling, genuine 308 resume semantics and session expiry cannot be proven
        // by a fake, however faithful. Two deliberate safety rails — the upload is forced PRIVATE
        // (a diagnostic must never put a video on a real channel's public feed) and it requires an
        // explicit videoUrl, so it can never fire by accident from a plain preflight call.
        if (platform === 'youtube') {
            let token: string;
            try {
                ({ token } = await resolveSocialCredentials(db, {
                    organisationId, platform: 'youtube', connectionId: body.connectionId,
                }));
            } catch (e) {
                return json(200, { preflight: 'fail', detail: e instanceof Error ? e.message : 'No connected YouTube channel for this organisation.' });
            }
            const idCheck = await fetchYouTubeIdentity(token);
            if (!idCheck.ok) return json(200, { preflight: 'fail', detail: idCheck.error, status: idCheck.status, code: idCheck.errorCode ?? null, subcode: idCheck.errorSubcode ?? null });
            if (!wantTestPost) return json(200, { preflight: 'ok', detail: `Authenticated as ${idCheck.id}.` });

            const videoUrl = String(body.videoUrl || '');
            if (!/^https:\/\//.test(videoUrl)) {
                return json(400, { preflight: 'ok', detail: 'A YouTube test upload needs an https videoUrl. Pass a small test clip.' });
            }
            const result: DriverResult = await publishYouTube(
                {
                    title: `Be More Swan publisher self-test ${new Date().toISOString()}`.slice(0, 100),
                    description: 'Automated publisher self-test — please ignore/delete.',
                    tags: [],
                },
                token,
                { url: videoUrl, mimeType: 'video/mp4' },
                { privacyStatus: 'private' },
            );
            return result.ok
                ? json(200, { preflight: 'ok', testPost: 'ok', postId: result.id, deleteHint: deleteHint(platform, result.id) })
                : json(200, { preflight: 'ok', testPost: 'fail', detail: result.error, status: result.status, code: result.errorCode ?? null, subcode: result.errorSubcode ?? null });
        }

        // ── Threads: verify the profile, then optionally publish ONE text-only test post. ──
        // Workspace-backed like YouTube, so credentials come through resolveSocialCredentials and
        // externalUserId is the Threads user id the publish endpoints are rooted at (/{id}/threads).
        // Text-only by design: Threads is the one platform here where media is not mandatory, and a
        // diagnostic should exercise the smallest path that proves the token and the two-step
        // container publish. Unlike the YouTube arm there is no private mode to hide behind — see
        // deleteHint — so it stays behind the same explicit confirmTestPost gate as the rest.
        if (platform === 'threads') {
            let token: string, threadsUserId: string | null;
            try {
                ({ token, externalUserId: threadsUserId } = await resolveSocialCredentials(db, {
                    organisationId, platform: 'threads', connectionId: body.connectionId,
                }));
            } catch (e) {
                return json(200, { preflight: 'fail', detail: e instanceof Error ? e.message : 'No connected Threads profile for this organisation.' });
            }
            const idCheck = await fetchThreadsIdentity(token);
            if (!idCheck.ok) return json(200, { preflight: 'fail', detail: idCheck.error, status: idCheck.status, code: idCheck.errorCode ?? null, subcode: idCheck.errorSubcode ?? null });
            if (!wantTestPost) return json(200, { preflight: 'ok', detail: `Authenticated as ${idCheck.id}.` });

            const result: DriverResult = await publishThreads(testMessage(), token, threadsUserId, null);
            return result.ok
                ? json(200, { preflight: 'ok', testPost: 'ok', postId: result.id, deleteHint: deleteHint(platform, result.id) })
                : json(200, { preflight: 'ok', testPost: 'fail', detail: result.error, status: result.status, code: result.errorCode ?? null, subcode: result.errorSubcode ?? null });
        }

        // ── Facebook: resolve the Page id + Page token (read-only Graph GET), then optionally post. ──
        if (platform === 'facebook') {
            let pageId: string, pageToken: string;
            try {
                ({ pageId, pageToken } = await resolveFacebookPageCredentials(db, { organisationId, connectionId: body.connectionId }));
            } catch (e) {
                return json(200, { preflight: 'fail', detail: e instanceof Error ? e.message : 'Could not resolve a Facebook Page.' });
            }
            if (!wantTestPost) return json(200, { preflight: 'ok', detail: `Resolved Facebook Page ${pageId} and a Page access token.` });
            const result: DriverResult = await publishFacebook(pageId, pageToken, testMessage(), null);
            return result.ok
                ? json(200, { preflight: 'ok', testPost: 'ok', postId: result.id, deleteHint: deleteHint(platform, result.id) })
                : json(200, { preflight: 'ok', testPost: 'fail', detail: result.error, status: result.status, code: result.errorCode ?? null, subcode: result.errorSubcode ?? null });
        }

        // ── X / LinkedIn: resolve the connection + token, run a read-only identity check, then post. ──
        const conn = await resolveConnection(db, organisationId, platform, body.connectionId);
        if (!conn?.vaultRefKey) return json(200, { preflight: 'fail', detail: `No active ${LABEL[platform]} connection for this organisation.` });
        const secret = await getSecret(db, conn.vaultRefKey);
        let token = secret?.token as string | undefined;
        if (!token) return json(200, { preflight: 'fail', detail: 'No token stored in the vault for this connection.' });

        if (platform === 'x') {
            let idCheck = await fetchXIdentity(token);
            // Token expired → refresh once and retry the identity check.
            if (!idCheck.ok && idCheck.status === 401) {
                const fresh = await refreshXToken(db, conn.vaultRefKey);
                if (fresh) { token = fresh; idCheck = await fetchXIdentity(token); }
            }
            if (!idCheck.ok) return json(200, { preflight: 'fail', detail: idCheck.error, status: idCheck.status, code: idCheck.errorCode ?? null, subcode: idCheck.errorSubcode ?? null });
            if (!wantTestPost) return json(200, { preflight: 'ok', detail: `Authenticated as ${idCheck.id}.` });
            const result = await publishX(testMessage(), token, null);
            return result.ok
                ? json(200, { preflight: 'ok', testPost: 'ok', postId: result.id, deleteHint: deleteHint(platform, result.id) })
                : json(200, { preflight: 'ok', testPost: 'fail', detail: result.error, status: result.status, code: result.errorCode ?? null, subcode: result.errorSubcode ?? null });
        }

        // linkedin
        const author = await resolveLinkedInAuthor(token);
        if (!author.ok) return json(200, { preflight: 'fail', detail: author.error, status: author.status });
        if (!wantTestPost) return json(200, { preflight: 'ok', detail: `Resolved author ${author.urn}.` });
        const result = await publishLinkedIn(testMessage(), token, conn.externalUserId || author.urn, null);
        return result.ok
            ? json(200, { preflight: 'ok', testPost: 'ok', postId: result.id, deleteHint: deleteHint(platform, result.id) })
            : json(200, { preflight: 'ok', testPost: 'fail', detail: result.error, status: result.status, code: result.errorCode ?? null, subcode: result.errorSubcode ?? null });
    } catch (err) {
        return json(500, { preflight: 'error', detail: err instanceof Error ? err.message : 'Self-test failed unexpectedly.' });
    }
});
