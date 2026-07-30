// src/utils/follower-counts.ts
// Shared follower/subscriber-count refresh, used by BOTH:
//   • netlify/functions/get-follower-counts.ts — the workspace Audience block's read endpoint
//   • netlify/functions/refresh-follower-counts.ts — the 4-hourly background cron
// Extracted so the two can never drift: before the cron existed this logic lived inline in the read
// endpoint, and a second copy in the cron would have meant two definitions of "what Instagram's
// follower count is" and two cache-write shapes.
//
// Coverage is permanently uneven, and a `{ available: false }` row is CORRECT behaviour rather than a
// bug to chase:
//   YouTube            — statistics.subscriberCount (null if the channel hides it)
//   Instagram/Facebook — Graph followers_count / fan_count
//   X (Twitter)        — public_metrics.followers_count, IF the app's API tier allows /users/me
//   Threads            — best-effort; needs the threads_manage_insights scope we don't request
//   LinkedIn           — NOT available for personal profiles, so it's entered manually and this module
//                        skips it entirely (reported back via `manualPlatforms`)
// Every fetch is wrapped so one platform failing never fails the whole sweep (that row shows "—").
import { and, eq } from 'drizzle-orm';
import { systemConnections, workspaceIntegrations } from '../../db/schema';
import { getSecret } from './vault';
import { normalizePlatform } from '../config/platform-formats';

// Platforms whose token lives in workspace_integrations (not system_connections).
const WORKSPACE_PLATFORMS = ['threads', 'youtube'] as const;
const THREADS_API = 'https://graph.threads.net/v1.0';
const GRAPH = 'https://graph.facebook.com/v21.0';

// How long a fetched count is served from cache. The background sweep
// (netlify/functions/refresh-follower-counts.ts) is scheduled to match, so raising this means the
// figures on screen get older; lowering it means more third-party calls. Everything downstream
// derives from this single constant — the cron's staleness threshold, and the cadence wording the
// Audience block prints ("every 4 hours") via the endpoint's cacheTtlMinutes. Change the netlify.toml
// schedule and the staging workflow's cron to match, or the sweep and the promise diverge.
export const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Platforms that have an active connection but can never be fetched from an API, so the count is
// user-entered. The caller pairs these with its own manual-entry store.
const MANUAL_ONLY_PLATFORMS = new Set(['linkedin']);

export type CountResult = { count: number | null; available: boolean; note?: string };

export type FollowerRow = {
    platform: string;
    count: number | null;
    available: boolean;
    note?: string;
    source?: 'manual';
    recordedAt?: string | null;
    manualAllowed?: boolean;
    // When this figure was last pulled from the platform, and when it next becomes eligible to be
    // pulled again. nextRefreshAt is fetchedAt + CACHE_TTL_MS.
    fetchedAt?: string | null;
    nextRefreshAt?: string | null;
};

export const nextRefreshFrom = (iso: string) => new Date(Date.parse(iso) + CACHE_TTL_MS).toISOString();

export async function fetchPlatformCount(
    platform: string,
    token: string,
    externalUserId: string | null,
    metadata: Record<string, unknown>,
): Promise<CountResult> {
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
            // hold organisation-page scopes here — so it's entered manually by the user.
            return { count: null, available: false, note: 'not available on LinkedIn' };
        }
        return { count: null, available: false };
    } catch {
        return { count: null, available: false, note: 'error' };
    }
}

export type RefreshResult = {
    rows: FollowerRow[];
    /** Platforms with an active connection whose count can only come from the user (LinkedIn). */
    manualPlatforms: string[];
    refreshed: number;
    cached: number;
};

/**
 * Refresh one organisation's API-backed follower counts, writing each result to the connection's
 * metadata cache (`followerCount` / `followerCountAt` / `followerCountNote`).
 *
 * `minAgeMs` is how stale a cached figure must be before it's re-fetched:
 *   • the read endpoint passes CACHE_TTL_MS — serve the cache for a full TTL, so opening the page
 *     repeatedly never hammers the platform APIs;
 *   • the cron passes something SHORTER than the TTL (see refresh-follower-counts.ts), so a
 *     run always finds the previous run's figures due — while a double-fire or a manual re-trigger
 *     minutes later still skips instead of re-fetching everything.
 * Pass 0 to force.
 *
 * LinkedIn is skipped rather than fetched (nothing to call) and reported via `manualPlatforms`, so
 * the caller can pair it with whatever manual-entry store it has.
 */
export async function refreshOrgFollowerCounts(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle db handle, typed at call sites
    db: any,
    organisationId: number,
    { minAgeMs = CACHE_TTL_MS }: { minAgeMs?: number } = {},
): Promise<RefreshResult> {
    const now = Date.now();
    const rows: FollowerRow[] = [];
    const manualPlatforms: string[] = [];
    let refreshed = 0;
    let cached = 0;

    // Serve-or-refresh for one connection row, whichever store it came from. Both stores use the same
    // three metadata keys, so the only difference is which table takes the UPDATE.
    const handle = async (
        platform: string,
        meta: Record<string, unknown>,
        externalUserId: string | null,
        getToken: () => Promise<string | null>,
        persist: (metadata: Record<string, unknown>) => Promise<unknown>,
    ) => {
        const cachedAt = typeof meta.followerCountAt === 'string' ? Date.parse(meta.followerCountAt) : 0;
        if (cachedAt && now - cachedAt < minAgeMs) {
            const value = (meta.followerCount ?? null) as number | null;
            const at = meta.followerCountAt as string;
            rows.push({ platform, count: value, available: value != null, note: (meta.followerCountNote as string | undefined) ?? undefined, fetchedAt: at, nextRefreshAt: nextRefreshFrom(at) });
            cached++;
            return;
        }

        const token = await getToken();
        const result: CountResult = token
            ? await fetchPlatformCount(platform, token, externalUserId, meta)
            : { count: null, available: false, note: 'no token' };

        // One timestamp for both the row and the cache write, so what the user sees is exactly what
        // the next request reads back out of the cache.
        const fetchedAt = new Date().toISOString();
        rows.push({ platform, ...result, fetchedAt, nextRefreshAt: nextRefreshFrom(fetchedAt) });
        refreshed++;
        await persist({ ...meta, followerCount: result.count, followerCountAt: fetchedAt, followerCountNote: result.note ?? null });
    };

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
        if (MANUAL_ONLY_PLATFORMS.has(platform)) { manualPlatforms.push(platform); continue; }

        const meta = (c.metadata as Record<string, unknown>) ?? {};
        await handle(
            platform,
            meta,
            c.externalUserId,
            async () => {
                if (!c.vaultRefKey) return null;
                const secret = await getSecret(db, c.vaultRefKey).catch(() => null);
                return (secret?.token as string | undefined) ?? null;
            },
            (metadata) => db.update(systemConnections).set({ metadata }).where(eq(systemConnections.id, c.id)).catch(() => { /* cache write is best-effort */ }),
        );
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
        await handle(
            platform,
            meta,
            w.tenantId,
            async () => {
                if (!w.vaultRefKey) return null;
                const secret = await getSecret(db, w.vaultRefKey).catch(() => null);
                return (secret?.accessToken as string | undefined) ?? (secret?.token as string | undefined) ?? null;
            },
            (metadata) => db.update(workspaceIntegrations).set({ metadata }).where(eq(workspaceIntegrations.id, w.id)).catch(() => { /* cache write is best-effort */ }),
        );
    }

    return { rows, manualPlatforms, refreshed, cached };
}
