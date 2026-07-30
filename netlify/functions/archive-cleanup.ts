// netlify/functions/archive-cleanup.ts
// Review Queue → Archive lifecycle: rejected posts are kept for 30 days, then hard-deleted.
// Scheduled via netlify.toml: runs daily at 04:00 UTC.
//
// Deletes scheduled_posts where status='rejected' AND rejected_at < now - 30d, releases their media
// to the content-retention pipeline (which reclaims the R2 objects), and logs a per-org summary to
// admin_audit_log.
//
// The media step used to soft-delete `workspace_assets` filtered on asset_type='social_image', using
// ids that belong to `content_assets` — two tables with independent id sequences. Post media was
// never reclaimed, and on an id collision it soft-deleted an unrelated workspace upload instead. See
// src/utils/release-post-media.ts before touching this.

import { Handler } from '@netlify/functions';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, adminAuditLog } from '../../db/schema';
import { releasePostMedia } from '../../src/utils/release-post-media';
import { withLambda } from '@netlify/aws-lambda-compat';

const ARCHIVE_RETENTION_DAYS = 30;

export default withLambda(async () => {
    const db = getDb();
    const now = new Date();
    const cutoff = new Date(now.getTime() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // Posts past their 30-day archive window.
    const expired = await db
        .select({
            id: scheduledPosts.id,
            organisationId: scheduledPosts.organisationId,
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

    // Release the media so content-retention reclaims the R2 objects after its 7-day window.
    // MUST run before the delete below: scheduled_post_assets cascades on post delete, and once
    // those rows are gone nothing can discover which assets these posts held.
    //
    // Best-effort — a storage bookkeeping failure must never strand a post in the archive forever —
    // but logged rather than swallowed, because a silent catch is how the previous version of this
    // step stayed broken.
    const ids = expired.map(p => p.id);
    let releasedAssets = 0;
    try {
        releasedAssets = await releasePostMedia(db, ids);
    } catch (err) {
        console.error('[archive-cleanup] media release failed (posts still deleted):', err);
    }

    // Hard-delete the expired posts.
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
        newState: {
            retentionDays: ARCHIVE_RETENTION_DAYS,
            deletedByOrg: summary,
            deletedCount: ids.length,
            releasedAssets,
        },
        ipAddress: 'scheduled',
    }).catch(() => {});

    console.log(`[archive-cleanup] deleted=${ids.length} posts past ${ARCHIVE_RETENTION_DAYS}-day archive window, releasedAssets=${releasedAssets}`);
    return { statusCode: 200, body: JSON.stringify({ deleted: ids.length, releasedAssets }) };
});
