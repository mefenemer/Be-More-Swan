// src/utils/blog-destinations/store.ts
// Credential custody for blog connectors. Reuses workspace_integrations (provider = `blog_<id>`) +
// vault_secrets, mirroring src/utils/workspace-integrations.ts — but kept SEPARATE from the OAuth
// IntegrationProvider union so the token-refresh machinery there never sees these paste-token creds.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { workspaceIntegrations } from '../../../db/schema';
import { storeSecret, getSecret, deleteSecret } from '../vault';
import { getProfileByOrg, ensureProfile } from '../swan-index/profile';
import { swanIndexProfiles, swanIndexPosts } from '../../../db/schema';
import { inArray } from 'drizzle-orm';
import { getFreshAccessToken, deleteIntegration, type IntegrationProvider } from '../workspace-integrations';
import { getBlogAdapter, BLOG_DESTINATION_IDS } from './index';
import type { BlogDestinationCreds, BlogDestinationId } from './types';

type Db = ReturnType<typeof getDb>;

/**
 * How a connected destination receives an auto-syndicated post on publish: as an unpublished
 * `draft` for the author to release on the platform itself, or straight to `live`. Default is
 * `draft` — a post published on our own site should never surprise-publish onto someone else's
 * blog (US 3.2 AC4). Hashnode has no draft API, so it is always treated as `live`.
 */
export type BlogPublishMode = 'draft' | 'live';
export const DEFAULT_PUBLISH_MODE: BlogPublishMode = 'draft';

const providerFor = (id: BlogDestinationId) => `blog_${id}`;
const refKeyFor = (organisationId: number, id: BlogDestinationId) => `aura/org-${organisationId}/blog-${id}`;
// Non-secret per-destination preferences (publish mode). Co-located in the blog-connector vault
// namespace so it needs no schema change; workspace_integrations has no JSON column to hold it.
const prefsRefKeyFor = (organisationId: number) => `aura/org-${organisationId}/blog-destination-prefs`;

/** All per-destination publish modes for an org, defaulting missing entries to `draft`. */
export async function getBlogPublishModes(db: Db, organisationId: number): Promise<Record<string, BlogPublishMode>> {
    const blob = (await getSecret(db, prefsRefKeyFor(organisationId)).catch(() => null)) as
        | { modes?: Record<string, string> }
        | null;
    const out: Record<string, BlogPublishMode> = {};
    for (const id of BLOG_DESTINATION_IDS) {
        out[id] = blob?.modes?.[id] === 'live' ? 'live' : 'draft';
    }
    return out;
}

/** Set one destination's publish mode, preserving the others. */
export async function setBlogPublishMode(
    db: Db,
    organisationId: number,
    id: BlogDestinationId,
    mode: BlogPublishMode,
): Promise<void> {
    const modes = await getBlogPublishModes(db, organisationId);
    modes[id] = mode;
    await storeSecret(db, prefsRefKeyFor(organisationId), { modes });
}

/** Store validated creds in the vault and upsert the (org, provider) row. */
export async function saveBlogDestination(
    db: Db,
    organisationId: number,
    userId: number,
    id: BlogDestinationId,
    creds: BlogDestinationCreds,
    accountLabel: string | null,
): Promise<void> {
    const refKey = refKeyFor(organisationId, id);
    await storeSecret(db, refKey, creds as unknown as Record<string, unknown>);
    await db
        .insert(workspaceIntegrations)
        .values({
            organisationId,
            provider: providerFor(id),
            vaultRefKey: refKey,
            externalAccountName: accountLabel,
            status: 'active',
            connectedBy: userId,
        })
        .onConflictDoUpdate({
            target: [workspaceIntegrations.organisationId, workspaceIntegrations.provider],
            set: {
                vaultRefKey: refKey,
                externalAccountName: accountLabel,
                status: 'active',
                connectedBy: userId,
                updatedAt: new Date(),
            },
        });
}

/** Decrypted creds for (org, id), or null if not connected. */
export async function getBlogDestinationCreds<C extends BlogDestinationCreds = BlogDestinationCreds>(
    db: Db,
    organisationId: number,
    id: BlogDestinationId,
): Promise<C | null> {
    const [row] = await db
        .select()
        .from(workspaceIntegrations)
        .where(and(eq(workspaceIntegrations.organisationId, organisationId), eq(workspaceIntegrations.provider, providerFor(id))))
        .limit(1);
    if (!row || row.status === 'revoked') return null;
    const secret = await getSecret(db, row.vaultRefKey).catch(() => null);
    return (secret as C) ?? null;
}

/**
 * Resolve ready-to-use creds for a destination, uniformly across auth kinds: paste-token creds come
 * from the vault; OAuth creds ({ accessToken, siteId }) come from the OAuth integration. Returns null
 * when not connected (the dispatcher records that as 'not_connected').
 */
export async function resolveDestinationCreds(
    db: Db,
    organisationId: number,
    id: BlogDestinationId,
): Promise<BlogDestinationCreds | null> {
    const adapter = getBlogAdapter(id);
    // First-party (The Swan Index): nothing to authenticate. The publication PROFILE is the
    // connection, so its presence and status are what "connected" means — returning null for a
    // suspended or withdrawn profile makes the dispatcher record 'not_connected', which is exactly
    // right: the workspace is not currently publishing there.
    if (adapter.authKind === 'firstparty') {
        const profile = await getProfileByOrg(db, organisationId);
        if (!profile || profile.status !== 'active') return null;
        return { organisationId } as BlogDestinationCreds;
    }
    if (adapter.authKind === 'oauth' && adapter.oauthProvider) {
        try {
            const fresh = await getFreshAccessToken(db, organisationId, adapter.oauthProvider as IntegrationProvider);
            if (!fresh.tenantId) return null; // no site id → connection is unusable
            return { accessToken: fresh.accessToken, siteId: fresh.tenantId } as BlogDestinationCreds;
        } catch {
            return null; // not_connected / expired → reconnect needed
        }
    }
    return getBlogDestinationCreds(db, organisationId, id);
}

/** Remove the connection and its vault secret (or the OAuth integration for OAuth destinations). */
export async function deleteBlogDestination(db: Db, organisationId: number, id: BlogDestinationId): Promise<void> {
    const adapter = getBlogAdapter(id);
    // First-party: disconnecting must actually take the author's articles OFF the publication —
    // it is the one destination where we can honour that, and an author who disconnects and still
    // sees their byline on someone else's masthead has been ignored.
    //
    // Withdrawn, not deleted. A hard delete would cascade the swan_index_posts rows away and with
    // them the editorial record of what this publication ran and when, which is the one thing a
    // publication must be able to answer about itself. Reconnecting restores the profile.
    if (adapter.authKind === 'firstparty') {
        const profile = await getProfileByOrg(db, organisationId);
        if (!profile) return;
        await db.update(swanIndexPosts)
            .set({ status: 'withdrawn', featuredRank: null, updatedAt: new Date() })
            .where(and(
                eq(swanIndexPosts.profileId, profile.id),
                inArray(swanIndexPosts.status, ['pending', 'live', 'featured']),
            ));
        await db.update(swanIndexProfiles)
            .set({ status: 'withdrawn', updatedAt: new Date() })
            .where(eq(swanIndexProfiles.id, profile.id));
        return;
    }
    if (adapter.authKind === 'oauth' && adapter.oauthProvider) {
        await deleteIntegration(db, organisationId, adapter.oauthProvider as IntegrationProvider);
        return;
    }
    await deleteSecret(db, refKeyFor(organisationId, id)).catch(() => {});
    await db
        .delete(workspaceIntegrations)
        .where(and(eq(workspaceIntegrations.organisationId, organisationId), eq(workspaceIntegrations.provider, providerFor(id))));
}

export interface BlogDestinationStatus {
    id: BlogDestinationId;
    label: string;
    connected: boolean;
    accountLabel: string | null;
    credFields: { key: string; label: string; secret: boolean; help?: string }[];
    /** True when this destination connects via OAuth (redirect) rather than a paste form. */
    oauth: boolean;
    /** For OAuth destinations: where the "Connect" button should redirect. */
    connectUrl?: string;
    /** True when the destination can be pushed as an unpublished draft (false for Hashnode). */
    supportsDraft: boolean;
    /** How this destination receives an auto-syndicated post on publish (draft unless set to live). */
    publishMode: BlogPublishMode;
}

/** Connection state for every adapter, for the integrations/settings UI. */
export async function listBlogDestinations(db: Db, organisationId: number): Promise<BlogDestinationStatus[]> {
    const rows = await db
        .select({ provider: workspaceIntegrations.provider, name: workspaceIntegrations.externalAccountName, status: workspaceIntegrations.status })
        .from(workspaceIntegrations)
        .where(eq(workspaceIntegrations.organisationId, organisationId));
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const modes = await getBlogPublishModes(db, organisationId);
    // First-party connection state lives in the profile table, not workspace_integrations — there is
    // no vault secret to hang a row off. One extra read for the whole list.
    const swanProfile = BLOG_DESTINATION_IDS.some((id) => getBlogAdapter(id).authKind === 'firstparty')
        ? await getProfileByOrg(db, organisationId)
        : null;
    return BLOG_DESTINATION_IDS.map((id) => {
        const adapter = getBlogAdapter(id);
        if (adapter.authKind === 'firstparty') {
            const connected = !!swanProfile && swanProfile.status === 'active';
            return {
                id,
                label: adapter.label,
                connected,
                accountLabel: connected ? `@${swanProfile!.handle}` : null,
                credFields: [],
                oauth: false,
                supportsDraft: adapter.supportsDraft,
                publishMode: modes[id],
            };
        }
        const isOAuth = adapter.authKind === 'oauth' && !!adapter.oauthProvider;
        // OAuth destinations live under their oauthProvider row; paste ones under `blog_<id>`.
        const row = byProvider.get(isOAuth ? adapter.oauthProvider! : providerFor(id));
        const connected = !!row && (isOAuth ? row.status === 'active' : row.status !== 'revoked');
        return {
            id,
            label: adapter.label,
            connected,
            accountLabel: row?.name ?? null,
            credFields: adapter.credFields,
            oauth: isOAuth,
            connectUrl: isOAuth ? `/api/oauth/${adapter.oauthProvider}/connect` : undefined,
            supportsDraft: adapter.supportsDraft,
            // Hashnode can't draft, so it always reports live regardless of the stored preference.
            publishMode: adapter.supportsDraft ? modes[id] : 'live',
        };
    });
}


/**
 * Connect the first-party destination: create (or reinstate) the workspace's publication profile.
 *
 * Separate from saveBlogDestination because there is nothing to validate and nothing to encrypt —
 * routing it through the vault path would store an empty secret and an integration row that no
 * code reads, purely to make one function signature cover two unlike things.
 */
export async function connectSwanIndex(
    db: Db,
    organisationId: number,
    userId: number,
): Promise<{ handle: string; displayName: string }> {
    const profile = await ensureProfile(db, organisationId, { userId });
    if (profile.status !== 'active') {
        await db.update(swanIndexProfiles)
            .set({ status: 'active', updatedAt: new Date() })
            .where(eq(swanIndexProfiles.id, profile.id));
    }
    return { handle: profile.handle, displayName: profile.displayName };
}
