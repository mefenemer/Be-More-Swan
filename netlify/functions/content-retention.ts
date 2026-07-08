// content-retention.ts — Automated data retention & cost optimization (US4)
// Runs as a scheduled Netlify function (cron) — every 6 hours
// 1. Purges POSTED assets whose retentionDeleteAfter has elapsed (30-day window)
// 2. Purges REJECTED assets whose retentionDeleteAfter has elapsed (7-day window)
//
// Physical file deletion: when S3 is wired, deletes the object by storageKey.
// Database: strips storageUrl/storageKey and marks purgedAt.

import type { Handler } from '@netlify/functions';
import { lte, and, isNull, isNotNull, inArray, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, integrationApiCalls } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const S3_BUCKET  = process.env.S3_BUCKET_NAME;
const S3_REGION  = process.env.S3_REGION || 'us-east-1';
const AWS_KEY    = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY;

async function deleteFromS3(keys: string[]) {
    if (!S3_BUCKET || !AWS_KEY || !AWS_SECRET || keys.length === 0) return;
    try {
        const { S3Client, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: S3_REGION });
        await s3.send(new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: { Objects: keys.map(k => ({ Key: k })) },
        }));
    } catch (err) {
        console.error('S3 batch delete failed:', err);
    }
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

        console.log(`[Retention] Purging ${due.length} assets.`);

        // 1. Delete physical files from S3
        const s3Keys = due.map(a => a.storageKey).filter(Boolean) as string[];
        await deleteFromS3(s3Keys);

        // 2. Update DB: strip file payload, mark purgedAt
        const ids = due.map(a => a.id);
        await db.update(contentAssets).set({
            storageKey: null,
            storageUrl: null,
            purgedAt: now,
            updatedAt: now,
        }).where(inArray(contentAssets.id, ids));

        console.log(`[Retention] Purged ${ids.length} assets. IDs: ${ids.join(', ')}`);

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
