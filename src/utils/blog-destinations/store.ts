// src/utils/blog-destinations/store.ts
// Credential custody for blog connectors. Reuses workspace_integrations (provider = `blog_<id>`) +
// vault_secrets, mirroring src/utils/workspace-integrations.ts — but kept SEPARATE from the OAuth
// IntegrationProvider union so the token-refresh machinery there never sees these paste-token creds.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { workspaceIntegrations } from '../../../db/schema';
import { storeSecret, getSecret, deleteSecret } from '../vault';
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

/** Remove the connection and its vault secret. */
export async function deleteBlogDestination(db: Db, organisationId: number, id: BlogDestinationId): Promise<void> {
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
        const row = byProvider.get(providerFor(id));
        return {
            id,
            label: adapter.label,
            connected: !!row && row.status !== 'revoked',
            accountLabel: row?.name ?? null,
            credFields: adapter.credFields,
        };
    });
}
