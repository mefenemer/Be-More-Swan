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
    fetchXIdentity, resolveLinkedInAuthor, resolveFacebookPageCredentials,
    publishX, publishLinkedIn, publishFacebook, refreshXToken,
    type DriverResult,
} from '../../src/utils/social-publish';
import { withLambda } from '@netlify/aws-lambda-compat';

const PLATFORMS = ['facebook', 'linkedin', 'x'] as const;
type SelfTestPlatform = typeof PLATFORMS[number];

const LABEL: Record<SelfTestPlatform, string> = { facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X (Twitter)' };

// A test post that is unmistakably a diagnostic, timestamped so repeated runs stay unique.
function testMessage(): string {
    return `✅ Be More Swan publisher self-test — please ignore/delete. ${new Date().toISOString()}`;
}

// How to remove the test post afterwards, per platform (surfaced to the user; we never auto-delete).
function deleteHint(platform: SelfTestPlatform, id: string): string {
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

    let body: { platform?: string; connectionId?: number; confirmTestPost?: boolean };
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
                : json(200, { preflight: 'ok', testPost: 'fail', detail: result.error, status: result.status });
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
            if (!idCheck.ok) return json(200, { preflight: 'fail', detail: idCheck.error, status: idCheck.status });
            if (!wantTestPost) return json(200, { preflight: 'ok', detail: `Authenticated as ${idCheck.id}.` });
            const result = await publishX(testMessage(), token, null);
            return result.ok
                ? json(200, { preflight: 'ok', testPost: 'ok', postId: result.id, deleteHint: deleteHint(platform, result.id) })
                : json(200, { preflight: 'ok', testPost: 'fail', detail: result.error, status: result.status });
        }

        // linkedin
        const author = await resolveLinkedInAuthor(token);
        if (!author.ok) return json(200, { preflight: 'fail', detail: author.error, status: author.status });
        if (!wantTestPost) return json(200, { preflight: 'ok', detail: `Resolved author ${author.urn}.` });
        const result = await publishLinkedIn(testMessage(), token, conn.externalUserId || author.urn, null);
        return result.ok
            ? json(200, { preflight: 'ok', testPost: 'ok', postId: result.id, deleteHint: deleteHint(platform, result.id) })
            : json(200, { preflight: 'ok', testPost: 'fail', detail: result.error, status: result.status });
    } catch (err) {
        return json(500, { preflight: 'error', detail: err instanceof Error ? err.message : 'Self-test failed unexpectedly.' });
    }
});
