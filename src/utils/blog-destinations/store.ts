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

const providerFor = (id: BlogDestinationId) => `blog_${id}`;
const refKeyFor = (organisationId: number, id: BlogDestinationId) => `aura/org-${organisationId}/blog-${id}`;

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
}

/** Connection state for every adapter, for the integrations/settings UI. */
export async function listBlogDestinations(db: Db, organisationId: number): Promise<BlogDestinationStatus[]> {
    const rows = await db
        .select({ provider: workspaceIntegrations.provider, name: workspaceIntegrations.externalAccountName, status: workspaceIntegrations.status })
        .from(workspaceIntegrations)
        .where(eq(workspaceIntegrations.organisationId, organisationId));
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
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
        };
    });
}
