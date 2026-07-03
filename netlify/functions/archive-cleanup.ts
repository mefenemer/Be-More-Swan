// netlify/functions/archive-cleanup.ts
// Review Queue → Archive lifecycle: rejected posts are kept for 30 days, then hard-deleted.
// Scheduled via netlify.toml: runs daily at 04:00 UTC.
//
// Deletes scheduled_posts where status='rejected' AND rejected_at < now - 30d, soft-deletes their
// social_image media (the existing storage-lifecycle-cleanup then reclaims the R2 objects), and logs
// a per-org summary to admin_audit_log. Mirrors netlify/functions/storage-lifecycle-cleanup.ts.

import { Handler } from '@netlify/functions';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, workspaceAssets, adminAuditLog } from '../../db/schema';

const ARCHIVE_RETENTION_DAYS = 30;

export const handler: Handler = async () => {
    const db = getDb();
    const now = new Date();
    const cutoff = new Date(now.getTime() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // Posts past their 30-day archive window.
    const expired = await db
        .select({
            id: scheduledPosts.id,
            organisationId: scheduledPosts.organisationId,
            contentAssetIds: scheduledPosts.contentAssetIds,
        })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.status, 'rejected'),
            lt(scheduledPosts.rejectedAt, cutoff),
        ))
        .limit(500);

    if (!expired.length) {
        return { statusCode: 200, body: JSON.stringify({ deleted: 0 }) };
    }

    // Soft-delete attached social_image assets so storage-lifecycle-cleanup reclaims the R2 objects
    // after its own 30-day grace. Best-effort — never blocks the post deletion.
    const assetIds = expired.flatMap(p => (p.contentAssetIds as number[] | null) ?? []);
    if (assetIds.length) {
        await db.update(workspaceAssets)
            .set({ status: 'deleted', deletedAt: now, updatedAt: now })
            .where(and(
                inArray(workspaceAssets.id, assetIds),
                eq(workspaceAssets.assetType, 'social_image'),
            ))
            .catch(() => {});
    }

    // Hard-delete the expired posts.
    const ids = expired.map(p => p.id);
    await db.delete(scheduledPosts).where(inArray(scheduledPosts.id, ids));

    // Per-org summary for the admin audit log.
    const summary: Record<number, number> = {};
    for (const p of expired) {
        const org = p.organisationId ?? 0;
        summary[org] = (summary[org] ?? 0) + 1;
    }

    await db.insert(adminAuditLog).values({
        adminId: null,
        action: 'archive_cleanup',
        targetType: 'scheduled_posts',
        targetId: null,
        newState: { retentionDays: ARCHIVE_RETENTION_DAYS, deletedByOrg: summary, deletedCount: ids.length },
        ipAddress: 'scheduled',
    }).catch(() => {});

    console.log(`[archive-cleanup] deleted=${ids.length} posts past ${ARCHIVE_RETENTION_DAYS}-day archive window`);
    return { statusCode: 200, body: JSON.stringify({ deleted: ids.length }) };
};
