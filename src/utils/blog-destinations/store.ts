// src/utils/blog-destinations/store.ts
// Credential custody for blog connectors. Reuses workspace_integrations (provider = `blog_<id>`) +
// vault_secrets, mirroring src/utils/workspace-integrations.ts — but kept SEPARATE from the OAuth
// IntegrationProvider union so the token-refresh machinery there never sees these paste-token creds.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { workspaceIntegrations } from '../../../db/schema';
import { storeSecret, getSecret, deleteSecret } from '../vault';
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
    return BLOG_DESTINATION_IDS.map((id) => {
        const adapter = getBlogAdapter(id);
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
