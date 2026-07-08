// netlify/functions/storage-lifecycle-cleanup.ts
// US-STOR-1.1.2 AC7-AC10: Nightly orphaned-file cleanup.
// Scheduled via netlify.toml: runs at 02:00 UTC daily.
//
// Deletes from R2 + DB:
//   - status='pending'  AND createdAt < now - 30m  (upload never confirmed)
//   - status='expired'                               (already marked expired)
//   - status='deleted'  AND deletedAt < now - 30d   (30-day grace period)
//
// AC8: decrements storageUsage.usedBytes for each confirmed deletion.
// AC9: logs summary to admin_audit_log.
// AC10: verifies R2 object absent via HEAD after delete; retries next run if failure.

import { Handler } from '@netlify/functions';
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { eq, and, lt, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workspaceAssets, storageUsage, adminAuditLog } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET   = process.env.R2_BUCKET_NAME;

function getR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
}

async function deleteFromR2(s3: S3Client, key: string): Promise<boolean> {
    if (!R2_BUCKET || !key) return true; // mock mode
    try {
        await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        // AC10: confirm absent via HEAD
        try {
            await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
            return false; // still exists — deletion failed
        } catch (headErr: any) {
            if (headErr?.name === 'NotFound' || headErr?.$metadata?.httpStatusCode === 404) return true;
            return false;
        }
    } catch {
        return false;
    }
}

export default withLambda(async () => {
    const db = getDb();
    const s3 = getR2Client();
    const now = new Date();
    const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    // AC12: Soft-delete unapproved generated_content older than 14 days before hard-delete pass
    await db.execute(
        sql`UPDATE workspace_assets
            SET status = 'deleted', deleted_at = now(), updated_at = now()
            WHERE asset_type = 'generated_content'
              AND status NOT IN ('deleted','expired','pending')
              AND created_at < ${fourteenDaysAgo.toISOString()}::timestamptz`
    );

    // Collect candidates for hard-delete
    const candidates = await db.execute<{
        id: number; organisation_id: number; r2_key: string | null;
        file_size_bytes: number | null; status: string;
    }>(
        sql`SELECT id, organisation_id, r2_key, file_size_bytes, status
            FROM workspace_assets
            WHERE (status = 'pending' AND created_at < ${thirtyMinsAgo.toISOString()}::timestamptz)
               OR (status = 'expired')
               OR (status = 'deleted' AND deleted_at < ${thirtyDaysAgo.toISOString()}::timestamptz)
            LIMIT 500`
    );

    const summary: Record<number, { deletedCount: number; reclaimedBytes: number }> = {};

    for (const row of candidates) {
        const deleted = await deleteFromR2(s3, row.r2_key || '');
        if (!deleted) {
            console.warn(`[storage-lifecycle-cleanup] Failed to delete R2 key ${row.r2_key} for asset ${row.id} — will retry next run`);
            continue;
        }

        // Remove from DB
        await db.delete(workspaceAssets).where(eq(workspaceAssets.id, row.id));

        // AC8: decrement storageUsage only for confirmed files (pending files were never counted)
        if (row.status !== 'pending' && row.file_size_bytes && row.organisation_id) {
            await db.execute(
                sql`UPDATE storage_usage
                    SET used_bytes = GREATEST(0, used_bytes - ${row.file_size_bytes}), updated_at = now()
                    WHERE organisation_id = ${row.organisation_id}`
            );
        }

        const orgId = row.organisation_id;
        if (!summary[orgId]) summary[orgId] = { deletedCount: 0, reclaimedBytes: 0 };
        summary[orgId].deletedCount++;
        summary[orgId].reclaimedBytes += row.file_size_bytes ?? 0;
    }

    // AC9: log summary to admin_audit_log
    if (Object.keys(summary).length > 0) {
        await db.insert(adminAuditLog).values({
            adminId: null,
            action: 'storage_lifecycle_cleanup',
            targetType: 'workspace_assets',
            targetId: null,
            newState: summary,
            ipAddress: 'scheduled',
        });
    }

    const totalDeleted = Object.values(summary).reduce((s, o) => s + o.deletedCount, 0);
    const totalBytes   = Object.values(summary).reduce((s, o) => s + o.reclaimedBytes, 0);
    console.log(`[storage-lifecycle-cleanup] deleted=${totalDeleted} reclaimedBytes=${totalBytes}`);

    return { statusCode: 200, body: JSON.stringify({ deleted: totalDeleted, reclaimedBytes: totalBytes }) };
});
