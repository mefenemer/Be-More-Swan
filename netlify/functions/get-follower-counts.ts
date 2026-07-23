// netlify/functions/get-follower-counts.ts
// Per-platform follower / subscriber counts for the Autopilot "Content by platform" section.
// Fetches from each connected platform's own API using the vault-decrypted token, and caches the
// result ~1h on the connection's metadata (followerCount + followerCountAt) so a page load never
// hammers the platform APIs. Availability varies by platform and is reported per row:
//   YouTube            — statistics.subscriberCount (null if the channel hides it)
//   Instagram/Facebook — Graph followers_count / fan_count
//   X (Twitter)        — public_metrics.followers_count, IF the app's API tier allows /users/me
//   LinkedIn           — NOT available for personal profiles → { available:false }
// Every fetch is wrapped so one platform failing never fails the whole response (that row shows —).
import { withLambda } from '@netlify/aws-lambda-compat';
import { and, eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, workspaceIntegrations, manualFollowerCounts } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { requireTenant } from '../../src/utils/tenant';
import { normalizePlatform } from '../../src/config/platform-formats';

// Platforms whose token lives in workspace_integrations (not system_connections). Their follower
// counts are fetched here too so the Audience block isn't blind to them (Request 0.1).
const WORKSPACE_PLATFORMS = ['threads', 'youtube'] as const;
const THREADS_API = 'https://graph.threads.net/v1.0';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GRAPH = 'https://graph.facebook.com/v21.0';

type CountResult = { count: number | null; available: boolean; note?: string };

async function fetchCount(platform: string, token: string, externalUserId: string | null, metadata: Record<string, unknown>): Promise<CountResult> {
    try {
        if (platform === 'youtube') {
            const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) return { count: null, available: false, note: 'fetch failed' };
            const j = await res.json() as { items?: Array<{ statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }> };
            const stats = j?.items?.[0]?.statistics;
            if (stats?.hiddenSubscriberCount) return { count: null, available: false, note: 'hidden by channel' };
            const n = Number(stats?.subscriberCount);
            return Number.isFinite(n) ? { count: n, available: true } : { count: null, available: false };
        }
        if (platform === 'x') {
            const res = await fetch('https://api.twitter.com/2/users/me?user.fields=public_metrics', { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) return { count: null, available: false, note: res.status === 403 ? 'API tier' : 'fetch failed' };
            const j = await res.json() as { data?: { public_metrics?: { followers_count?: number } } };
            const n = Number(j?.data?.public_metrics?.followers_count);
            return Number.isFinite(n) ? { count: n, available: true } : { count: null, available: false };
        }
        if (platform === 'instagram') {
            if (!externalUserId) return { count: null, available: false, note: 'no account id' };
            const res = await fetch(`${GRAPH}/${externalUserId}?fields=followers_count&access_token=${encodeURIComponent(token)}`);
            if (!res.ok) return { count: null, available: false, note: 'fetch failed' };
            const j = await res.json() as { followers_count?: number };
            const n = Number(j?.followers_count);
            return Number.isFinite(n) ? { count: n, available: true } : { count: null, available: false };
        }
        if (platform === 'facebook') {
            const pageId = (metadata?.fbPageId as string | undefined) || externalUserId;
            if (!pageId) return { count: null, available: false, note: 'no page id' };
            const res = await fetch(`${GRAPH}/${pageId}?fields=followers_count,fan_count&access_token=${encodeURIComponent(token)}`);
            if (!res.ok) return { count: null, available: false, note: 'fetch failed' };
            const j = await res.json() as { followers_count?: number; fan_count?: number };
            const n = Number(j?.followers_count ?? j?.fan_count);
            return Number.isFinite(n) ? { count: n, available: true } : { count: null, available: false };
        }
        if (platform === 'threads') {
            // Threads exposes followers_count via the user-insights edge, which needs the
            // threads_manage_insights scope we don't currently request — so this is best-effort and
            // usually reports unavailable rather than a number. externalUserId = the Threads user id.
            if (!externalUserId) return { count: null, available: false, note: 'no account id' };
            const res = await fetch(`${THREADS_API}/${externalUserId}/threads_insights?metric=followers_count&access_token=${encodeURIComponent(token)}`);
            if (!res.ok) return { count: null, available: false, note: res.status === 403 ? 'insights scope' : 'fetch failed' };
            const j = await res.json() as { data?: Array<{ total_value?: { value?: number }; values?: Array<{ value?: number }> }> };
            const row = j?.data?.[0];
            const n = Number(row?.total_value?.value ?? row?.values?.[0]?.value);
            return Number.isFinite(n) ? { count: n, available: true } : { count: null, available: false };
        }
        if (platform === 'linkedin') {
            // Personal-profile follower count is not exposed by LinkedIn's member API, and we don't
            // hold organisation-page scopes here — so it's entered manually (handled before fetch).
            return { count: null, available: false, note: 'not available on LinkedIn' };
        }
        return { count: null, available: false };
    } catch {
        return { count: null, available: false, note: 'error' };
    }
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId } = ctx;
    if (!organisationId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation.' }) };

    const now = Date.now();
    type Row = { platform: string; count: number | null; available: boolean; note?: string; source?: 'manual'; recordedAt?: string | null; manualAllowed?: boolean };
    const counts: Row[] = [];

    // Latest manually-entered count per platform (LinkedIn today). Newest row wins.
    const manualRows = await db
        .select({ platform: manualFollowerCounts.platform, count: manualFollowerCounts.count, recordedAt: manualFollowerCounts.recordedAt })
        .from(manualFollowerCounts)
        .where(eq(manualFollowerCounts.organisationId, organisationId))
        .orderBy(desc(manualFollowerCounts.recordedAt));
    const latestManual = new Map<string, { count: number; recordedAt: string }>();
    for (const m of manualRows) {
        if (!latestManual.has(m.platform)) latestManual.set(m.platform, { count: m.count, recordedAt: (m.recordedAt as Date).toISOString() });
    }

    // ── system_connections platforms (Facebook / Instagram / X / LinkedIn) ───────────────────────
    const conns = await db
        .select({
            id: systemConnections.id,
            serviceName: systemConnections.serviceName,
            externalUserId: systemConnections.externalUserId,
            vaultRefKey: systemConnections.vaultRefKey,
            metadata: systemConnections.metadata,
        })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ));

    for (const c of conns) {
        const platform = normalizePlatform(c.serviceName);
        if (!platform) continue;

        // LinkedIn: the API can't supply this, so it's entered manually. Show the latest entry (with
        // its date), and flag manualAllowed so the UI offers the update input.
        if (platform === 'linkedin') {
            const m = latestManual.get('linkedin');
            counts.push(m
                ? { platform, count: m.count, available: true, source: 'manual', recordedAt: m.recordedAt, manualAllowed: true }
                : { platform, count: null, available: false, note: 'enter manually', manualAllowed: true });
            continue;
        }

        const meta = (c.metadata as Record<string, unknown>) ?? {};
        // Serve from cache when fresh — one hourly fetch per connection is plenty for a follower count.
        const cachedAt = typeof meta.followerCountAt === 'string' ? Date.parse(meta.followerCountAt) : 0;
        if (cachedAt && now - cachedAt < CACHE_TTL_MS) {
            const cached = (meta.followerCount ?? null) as number | null;
            counts.push({ platform, count: cached, available: cached != null, note: (meta.followerCountNote as string | undefined) ?? undefined });
            continue;
        }

        let token: string | null = null;
        if (c.vaultRefKey) {
            const secret = await getSecret(db, c.vaultRefKey).catch(() => null);
            token = (secret?.token as string | undefined) ?? null;
        }
        const result: CountResult = token
            ? await fetchCount(platform, token, c.externalUserId, meta)
            : { count: null, available: false, note: 'no token' };

        counts.push({ platform, ...result });
        await db.update(systemConnections)
            .set({ metadata: { ...meta, followerCount: result.count, followerCountAt: new Date().toISOString(), followerCountNote: result.note ?? null } })
            .where(eq(systemConnections.id, c.id))
            .catch(() => { /* cache write is best-effort */ });
    }

    // ── workspace_integrations platforms (Threads / YouTube) ─────────────────────────────────────
    // Their token lives in a different store ({ accessToken }, not { token }) and keyed on tenantId.
    const wsInts = await db
        .select({
            id: workspaceIntegrations.id,
            provider: workspaceIntegrations.provider,
            tenantId: workspaceIntegrations.tenantId,
            vaultRefKey: workspaceIntegrations.vaultRefKey,
            metadata: workspaceIntegrations.metadata,
        })
        .from(workspaceIntegrations)
        .where(and(
            eq(workspaceIntegrations.organisationId, organisationId),
            eq(workspaceIntegrations.status, 'active'),
        ));

    for (const w of wsInts) {
        const platform = normalizePlatform(w.provider);
        if (!platform || !(WORKSPACE_PLATFORMS as readonly string[]).includes(platform)) continue;

        const meta = (w.metadata as Record<string, unknown>) ?? {};
        const cachedAt = typeof meta.followerCountAt === 'string' ? Date.parse(meta.followerCountAt) : 0;
        if (cachedAt && now - cachedAt < CACHE_TTL_MS) {
            const cached = (meta.followerCount ?? null) as number | null;
            counts.push({ platform, count: cached, available: cached != null, note: (meta.followerCountNote as string | undefined) ?? undefined });
            continue;
        }

        let token: string | null = null;
        if (w.vaultRefKey) {
            const secret = await getSecret(db, w.vaultRefKey).catch(() => null);
            // workspace_integrations tokens are stored as { accessToken, refreshToken }.
            token = (secret?.accessToken as string | undefined) ?? (secret?.token as string | undefined) ?? null;
        }
        const result: CountResult = token
            ? await fetchCount(platform, token, w.tenantId, meta)
            : { count: null, available: false, note: 'no token' };

        counts.push({ platform, ...result });
        await db.update(workspaceIntegrations)
            .set({ metadata: { ...meta, followerCount: result.count, followerCountAt: new Date().toISOString(), followerCountNote: result.note ?? null } })
            .where(eq(workspaceIntegrations.id, w.id))
            .catch(() => { /* cache write is best-effort */ });
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ counts }) };
});
