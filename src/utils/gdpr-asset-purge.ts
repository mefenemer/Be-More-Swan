// src/utils/gdpr-asset-purge.ts
// US-GDPR-2.2.1: Purge extractedText & tombstone workspace assets on erasure.
// US-GDPR-2.2.2: Delete vector embeddings registered for the user's assets.
// Called by both admin-gdpr-erase.ts and account-delete-execute.ts.

import { and, eq, inArray } from 'drizzle-orm';
import { workspaceAssets, vectorEmbeddings, aiAssistants } from '../../db/schema';

export interface AssetPurgeResult {
  assetsPurged: number;
  storageBytesFreed: number;
  embeddingsDeleted: number;
  partialFailures: string[];    // listed in gdpr_erasure_log.metadata when non-empty
}

// Delete a file from object storage given its storageUrl.
// Be More Swan currently uses Netlify Blobs (or a compatible S3-style endpoint).
// The storageUrl is an internal path, not a public URL — we call the storage API directly.
// Returns the number of bytes freed (0 if unknown or API unavailable).
async function deleteStorageFile(storageUrl: string): Promise<number> {
    const storeApiUrl = process.env.NETLIFY_BLOBS_URL || process.env.STORAGE_API_URL;
    if (!storeApiUrl) return 0; // storage API not configured — log only, do not throw

    try {
        const res = await fetch(`${storeApiUrl}/delete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.NETLIFY_BLOBS_TOKEN
                    ? { Authorization: `Bearer ${process.env.NETLIFY_BLOBS_TOKEN}` }
                    : {}),
            },
            body: JSON.stringify({ key: storageUrl }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return 0;
        const data = await res.json().catch(() => ({})) as any;
        return data?.bytesFreed ?? data?.size ?? 0;
    } catch {
        return 0;
    }
}

export async function purgeUserAssets(
  db: ReturnType<typeof import('../../db/client').getDb>,
  uploaderId: number,
): Promise<AssetPurgeResult> {
  const assets = await db
    .select({ id: workspaceAssets.id, storageUrl: workspaceAssets.storageUrl })
    .from(workspaceAssets)
    .where(eq(workspaceAssets.uploaderId, uploaderId));

  const partialFailures: string[] = [];
  let embeddingsDeleted = 0;
  let storageBytesFreed = 0;

  if (assets.length > 0) {
    const assetIds = assets.map(a => a.id);

    // US-GDPR-2.2.2: delete all vector embeddings for these assets before nulling the source rows
    try {
      const deleted = await db
        .delete(vectorEmbeddings)
        .where(inArray(vectorEmbeddings.sourceId, assetIds))
        .returning({ id: vectorEmbeddings.id });
      embeddingsDeleted = deleted.length;
    } catch (err: any) {
      partialFailures.push(`vector_embeddings_delete — ${err?.message ?? 'unknown error'}`);
    }

    // US-GDPR-2.2.1: delete from object storage, then null out PII content and soft-delete
    for (const asset of assets) {
      try {
        // Delete physical file from object storage before clearing the DB reference
        if (asset.storageUrl) {
          const bytesFreed = await deleteStorageFile(asset.storageUrl).catch(() => 0);
          storageBytesFreed += bytesFreed;
        }

        await db
          .update(workspaceAssets)
          .set({
            extractedText: null,
            storageUrl: null,
            isActive: false,
            updatedAt: new Date(),
          })
          .where(eq(workspaceAssets.id, asset.id));
      } catch (err: any) {
        partialFailures.push(`asset:${asset.id} — ${err?.message ?? 'unknown error'}`);
      }
    }
  }

  // US-GDPR-2.2.2: also delete any conversation-sourced embeddings linked to this user
  try {
    const convDeleted = await db
      .delete(vectorEmbeddings)
      .where(eq(vectorEmbeddings.userId, uploaderId))
      .returning({ id: vectorEmbeddings.id });
    embeddingsDeleted += convDeleted.length;
  } catch (err: any) {
    partialFailures.push(`vector_embeddings_conv_delete — ${err?.message ?? 'unknown error'}`);
  }

  return {
    assetsPurged: assets.length - partialFailures.filter(f => f.startsWith('asset:')).length,
    storageBytesFreed,
    embeddingsDeleted,
    partialFailures,
  };
}

/** Tombstone assets belonging to a departing org member (non-erasure path).
 *  Scoped strictly to the organisation the user is leaving — does not affect
 *  their assets in other orgs where they remain a member. */
export async function tombstoneOrgMemberAssets(
  db: ReturnType<typeof import('../../db/client').getDb>,
  uploaderId: number,
  organisationId: number,
): Promise<number> {
  const now = new Date();
  const result = await db
    .update(workspaceAssets)
    .set({ isActive: false, updatedAt: now })
    .where(
      and(
        eq(workspaceAssets.uploaderId, uploaderId),
        eq(workspaceAssets.organisationId, organisationId),
      )
    )
    .returning({ id: workspaceAssets.id });

  // US-GDPR-2.2.3 AC2: flag all active assistants in this org so the UI can warn
  // that their knowledge base may be incomplete due to the tombstoned assets.
  if (result.length > 0) {
    await db
      .update(aiAssistants)
      .set({ knowledgeStaleAt: now, updatedAt: now })
      .where(
        and(
          eq(aiAssistants.organisationId, organisationId),
          eq(aiAssistants.isActive, true),
        )
      );
  }

  return result.length;
}
