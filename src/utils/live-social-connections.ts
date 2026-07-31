// src/utils/live-social-connections.ts
// ONE answer to "which social platforms is this organisation actually connected to?", spanning
// BOTH credential stores.
//
// Facebook/Instagram/LinkedIn/X authenticate into `system_connections`. Threads and YouTube
// authenticate into `workspace_integrations` (oauth-integrations.ts → saveIntegration), and no row
// is ever written to system_connections for them. Every caller that asked system_connections alone
// therefore read a fully-connected Threads account as "not connected" — silently, because absence
// is indistinguishable from "the user never connected it".
//
// That is how Autopilot came to fan a cross-post across four platforms and drop the fifth with no
// error: resolveConnectedDraftPlatforms intersected the org's system_connections rows with the
// drafter list, and Threads was never in the left-hand set.
//
// This is the read-side twin of resolveSocialCredentials (src/utils/social-publish.ts), which
// already bridges the two stores at publish time. Callers get platforms, not tokens, so this
// module stays free of the vault/S3 dependencies that make social-publish.ts expensive to import.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { systemConnections, workspaceIntegrations } from '../../db/schema';
import { normalizePlatform, SOCIAL_PLATFORMS, type SocialPlatform } from '../config/platform-formats';

/** Also satisfied by a drizzle transaction handle — several callers resolve inside one. */
type DbLike = Pick<ReturnType<typeof getDb>, 'select'>;

/**
 * Platforms whose tokens live in workspace_integrations rather than system_connections.
 * Re-exported by social-publish.ts, which is where the publish path reads it from.
 */
export const WORKSPACE_BACKED_PLATFORMS = new Set<string>(['threads', 'youtube']);

export interface LiveSocialConnection {
    platform: SocialPlatform;
    /**
     * The system_connections row id, or null when only workspace_integrations backs this platform.
     * Null is not a failure: scheduled_posts.connection_id is nullable and publish-social-posts
     * falls back to resolving by (organisation, platform) — see resolveSocialCredentials.
     */
    connectionId: number | null;
    store: 'system_connections' | 'workspace_integrations';
}

/**
 * Every social platform this org has a LIVE connection for, keyed by platform, in catalogue order.
 *
 * "Live" mirrors the publish path's own liveness test per store: status='active' AND is_active for
 * system_connections, status='active' for workspace_integrations (the token there is kept warm by
 * refresh-workspace-tokens and marked 'expired' when its refresh grant dies).
 */
export async function resolveLiveSocialConnections(
    db: DbLike,
    organisationId: number,
): Promise<Map<SocialPlatform, LiveSocialConnection>> {
    const [sysRows, wsRows] = await Promise.all([
        db.select({
            id: systemConnections.id,
            serviceName: systemConnections.serviceName,
            vaultRefKey: systemConnections.vaultRefKey,
        }).from(systemConnections).where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        )),
        db.select({
            provider: workspaceIntegrations.provider,
        }).from(workspaceIntegrations).where(and(
            eq(workspaceIntegrations.organisationId, organisationId),
            eq(workspaceIntegrations.status, 'active'),
            inArray(workspaceIntegrations.provider, [...WORKSPACE_BACKED_PLATFORMS]),
        )),
    ]);

    const live = new Map<SocialPlatform, LiveSocialConnection>();
    const shadowIds = new Map<SocialPlatform, number>();

    for (const row of sysRows) {
        const platform = normalizePlatform(row.serviceName);
        if (!platform) continue;
        // A workspace-backed platform's row here is a SHADOW row: it carries the per-assistant
        // toggle and nothing else (vaultRefKey NULL, see chooseCredentialSource). It holds no token,
        // so it cannot make the platform live on its own — only the store that owns the token can.
        // Its id is still worth keeping: that is what connection_id should point at when it exists.
        if (WORKSPACE_BACKED_PLATFORMS.has(platform) && !row.vaultRefKey) {
            shadowIds.set(platform, row.id);
            continue;
        }
        live.set(platform, { platform, connectionId: row.id, store: 'system_connections' });
    }

    for (const row of wsRows) {
        const platform = normalizePlatform(row.provider);
        if (!platform || live.has(platform)) continue;
        live.set(platform, {
            platform,
            connectionId: shadowIds.get(platform) ?? null,
            store: 'workspace_integrations',
        });
    }

    // Catalogue order, so a cross-post's platform list and every UI derived from it are stable
    // rather than dependent on row insertion order.
    return new Map(SOCIAL_PLATFORMS.filter(p => live.has(p)).map(p => [p, live.get(p)!]));
}

/** Just the platform keys, in catalogue order. */
export async function resolveLiveSocialPlatforms(db: DbLike, organisationId: number): Promise<SocialPlatform[]> {
    return [...(await resolveLiveSocialConnections(db, organisationId)).keys()];
}
