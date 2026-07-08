// netlify/functions/purge-tombstoned-assets.ts
// US-GDPR-2.2.1 Fix 3: Scheduled daily job — auto-purge tombstoned workspace assets
// after 30 days, honouring the promise made in the org-owner notification email
// sent by manage-members.ts.
//
// Schedule: runs daily at 03:00 UTC
// Selects: workspace_assets WHERE isActive=false AND updatedAt < NOW()-30d AND extractedText IS NOT NULL
// Action: delete from object storage, null extractedText + storageUrl, log count.

import type { Handler } from '@netlify/functions';
import { and, eq, lt, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workspaceAssets } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function deleteStorageFile(storageUrl: string): Promise<number> {
    const storeApiUrl = process.env.NETLIFY_BLOBS_URL || process.env.STORAGE_API_URL;
    if (!storeApiUrl) return 0;

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

async function runPurge(): Promise<{ purged: number; bytesFreed: number; errors: number }> {
    const db = getDb();
    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);

    const candidates = await db
        .select({ id: workspaceAssets.id, storageUrl: workspaceAssets.storageUrl })
        .from(workspaceAssets)
        .where(
            and(
                eq(workspaceAssets.isActive, false),
                lt(workspaceAssets.updatedAt, cutoff),
                isNotNull(workspaceAssets.extractedText),
            )
        );

    if (candidates.length === 0) {
        console.log('[purge-tombstoned-assets] No candidates to purge.');
        return { purged: 0, bytesFreed: 0, errors: 0 };
    }

    let purged = 0;
    let bytesFreed = 0;
    let errors = 0;

    for (const asset of candidates) {
        try {
            if (asset.storageUrl) {
                const freed = await deleteStorageFile(asset.storageUrl).catch(() => 0);
                bytesFreed += freed;
            }

            await db
                .update(workspaceAssets)
                .set({ extractedText: null, storageUrl: null, updatedAt: new Date() })
                .where(eq(workspaceAssets.id, asset.id));

            purged++;
        } catch (err: any) {
            errors++;
            console.error(`[purge-tombstoned-assets] Failed to purge asset ${asset.id}:`, err?.message);
        }
    }

    console.log(`[purge-tombstoned-assets] Purged ${purged} assets, freed ~${bytesFreed} bytes, ${errors} errors.`);
    return { purged, bytesFreed, errors };
}

export default withLambda(async () => {
    const result = await runPurge();
    return {
        statusCode: 200,
        body: JSON.stringify(result),
    };
});
