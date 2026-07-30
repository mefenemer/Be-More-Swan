// content-retention.ts — Automated data retention & cost optimization (US4)
// Scheduled via netlify.toml: runs daily at 05:00 UTC, after archive-cleanup (04:00) hands over the
// media of posts leaving the archive.
//
// ⚠️ This comment used to claim "every 6 hours" while netlify.toml listed no schedule for it at all,
// so the function had never once run. Both of the bugs described below were therefore latent rather
// than active — do not read the docstring as evidence that a cron exists; check netlify.toml.
//
// 1. Purges POSTED assets whose retentionDeleteAfter has elapsed (30-day window)
// 2. Purges REJECTED assets whose retentionDeleteAfter has elapsed (7-day window)
//
// Physical file deletion: removes the object from R2 by storageKey.
// Database: strips storageUrl/storageKey and marks purgedAt — but ONLY once the object is
// confirmed gone. See below.
//
// ── Two bugs this file used to have, both silent, both destructive if it had ever run ────────────
// 1. It deleted from AWS S3 (S3_BUCKET_NAME / AWS_ACCESS_KEY_ID / S3_REGION). Nothing else in this
//    codebase uses those variables — every upload and download path is Cloudflare R2
//    (R2_BUCKET_NAME, see content-upload-url.ts). So `deleteFromS3` early-returned on every run.
// 2. It stripped storageKey/storageUrl and stamped purgedAt REGARDLESS. The row then said "purged"
//    while the R2 object was still there — and because the key was the only record of where the
//    object lived, it became permanently unreclaimable. Every 6 hours, for every asset reaching its
//    retention date.
//
// The rule that prevents a repeat: purgedAt means "the bytes are gone". Never stamp it on an asset
// whose object we did not actually delete. An asset with no storageKey (a Pexels hotlink, a link
// asset, an already-purged row) has no bytes to delete and may be stamped immediately; anything
// with a key must survive to the next run if the delete failed or storage was unconfigured.

import type { Handler } from '@netlify/functions';
import { lte, and, isNull, isNotNull, inArray, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, integrationApiCalls } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

// Same R2 configuration every other storage path in this app uses (content-upload-url.ts,
// content-assets.ts, storage-lifecycle-cleanup.ts). Read lazily inside the handler rather than at
// module scope so a redeploy that adds the vars takes effect without a cold-start dance.
function r2Config() {
    return {
        endpoint:  process.env.R2_ENDPOINT,
        accessKey: process.env.R2_ACCESS_KEY_ID,
        secretKey: process.env.R2_SECRET_ACCESS_KEY,
        bucket:    process.env.R2_BUCKET_NAME,
    };
}

/**
 * Deletes each key from R2, returning the subset confirmed gone.
 *
 * Per-key rather than a single DeleteObjects batch on purpose: a batch reports partial failure in a
 * per-object Errors array that the old code never inspected, so one bad key would have marked the
 * whole batch purged. Here a failure is scoped to its own asset and simply retries next run.
 */
async function deleteFromR2(keys: string[]): Promise<Set<string>> {
    const deleted = new Set<string>();
    if (keys.length === 0) return deleted;

    const { endpoint, accessKey, secretKey, bucket } = r2Config();
    if (!endpoint || !accessKey || !secretKey || !bucket) {
        // Deliberately returns nothing rather than pretending success — the callers' assets keep
        // their storageKey and are retried on the next run.
        console.warn(`[Retention] R2 not configured — deferring ${keys.length} object deletion(s) to a later run.`);
        return deleted;
    }

    try {
        const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
            region: 'auto',
            endpoint,
            credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        });
        for (const key of keys) {
            try {
                await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
                deleted.add(key);
            } catch (err) {
                console.error(`[Retention] Failed to delete R2 object ${key} — will retry next run:`, err);
            }
        }
    } catch (err) {
        console.error('[Retention] R2 client unavailable — deferring all object deletions:', err);
    }
    return deleted;
}

const retentionHandler = async () => {
    const db = getDb();
    const now = new Date();

    try {
        // Find all assets past their retention window that haven't been purged yet
        const due = await db.select({
            id: contentAssets.id,
            storageKey: contentAssets.storageKey,
            status: contentAssets.status,
        }).from(contentAssets).where(
            and(
                isNotNull(contentAssets.retentionDeleteAfter),
                lte(contentAssets.retentionDeleteAfter, now),
                isNull(contentAssets.purgedAt),
            )
        );

        if (due.length === 0) {
            console.log('[Retention] No assets due for purge.');
            return { statusCode: 200, body: 'No assets to purge.' };
        }

        console.log(`[Retention] ${due.length} asset(s) due for purge.`);

        // 1. Delete the physical objects from R2.
        const keyed = due.filter((a): a is typeof a & { storageKey: string } => !!a.storageKey);
        const deletedKeys = await deleteFromR2(keyed.map(a => a.storageKey));

        // 2. Only assets whose bytes are genuinely gone may be stamped purged. Assets with no
        //    storageKey (Pexels hotlinks, link assets) have nothing to delete and qualify at once;
        //    keyed assets qualify only on a confirmed delete. The rest keep their key and retry.
        const purgeable = due.filter(a => !a.storageKey || deletedKeys.has(a.storageKey));
        const deferred  = due.length - purgeable.length;

        const ids = purgeable.map(a => a.id);
        if (ids.length > 0) {
            await db.update(contentAssets).set({
                storageKey: null,
                storageUrl: null,
                purgedAt: now,
                updatedAt: now,
            }).where(inArray(contentAssets.id, ids));
            console.log(`[Retention] Purged ${ids.length} assets. IDs: ${ids.join(', ')}`);
        }
        if (deferred > 0) {
            console.warn(`[Retention] Deferred ${deferred} asset(s) — object still present in R2; retrying next run.`);
        }

        // US-AUD-4.2.1 SC6: Purge integration_api_calls older than 90 days
        const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        const deletedCalls = await db
            .delete(integrationApiCalls)
            .where(lt(integrationApiCalls.calledAt, ninetyDaysAgo))
            .returning({ id: integrationApiCalls.id });
        if (deletedCalls.length > 0) {
            console.log(`[Retention] Purged ${deletedCalls.length} integration API call log rows older than 90 days.`);
        }

        return { statusCode: 200, body: `Purged ${ids.length} assets; ${deletedCalls.length} API call log rows.` };

    } catch (err) {
        console.error('[Retention] Error:', err);
        return { statusCode: 500, body: 'Retention job failed.' };
    }
};

// Run every 6 hours
export default withLambda(retentionHandler);
