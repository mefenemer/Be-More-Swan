// src/utils/library-retention.ts
// When a My Content file will be deleted, the week's notice before it is, and how much storage the
// workspace is using — in ONE place, so the date My Content shows and the purge agree.
//
// ── Why (owner, 2026-11-10) ──────────────────────────────────────────────────────────────────────
// Files are deleted on clocks (posted media 30 days after posting, rejected 7 days, unused generated
// cards 30 days after they are made — content-retention.ts), but only unused cards could be kept, a
// kept file could still be put back on a clock when its post went out, and nobody was told before a
// deletion. Now:
//   • Keep works on any file and is permanent: every clock skips a kept file, and the purge does too.
//   • A file is only deleted after its owner was told at least DELETION_NOTICE_DAYS before, by a
//     notification that opens My Content on the files due to go (deletion_warned_at).
//   • Uploads refused by the safety check are the exception: never offered Keep, deleted on their
//     clock without a notice.
//
// ⚠️ db/z-content-deletion-warning.sql (the deletion_warned_at column) must be applied to BOTH
// databases before this deploys: content-assets.ts selects whole rows.

import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets, masterPlans, plans, storageUsage } from '../../db/schema';
import { isSharedLibraryKey } from '../lib/music-library';
import { createNotification } from './notify';

type Db = ReturnType<typeof getDb>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days between the notice and the deletion. Stated to the user verbatim. */
export const DELETION_NOTICE_DAYS = 7;
/** The purge runs daily at about the same time; a notice sent a few minutes later than last week's
 *  run must not push the deletion a whole extra day. */
const RUN_DRIFT_MS = 2 * 60 * 60 * 1000;

export interface RetentionRow {
    status: string;
    rejectionReason?: string | null;
    retentionDeleteAfter?: Date | string | null;
    libraryKeptAt?: Date | string | null;
    deletionWarnedAt?: Date | string | null;
    purgedAt?: Date | string | null;
}

/** Refused by the safety check on upload: no Keep, no notice. Pure. */
export function isSafetyRejected(r: Pick<RetentionRow, 'status' | 'rejectionReason'>): boolean {
    return r.status === 'rejected' && !!(r.rejectionReason && String(r.rejectionReason).trim());
}

/** Can the user press Keep on this file? Pure. */
export function canKeep(r: RetentionRow): boolean {
    return !r.purgedAt && !r.libraryKeptAt && !isSafetyRejected(r);
}

/**
 * The date this file will actually be deleted, or null when nothing will delete it. Pure.
 * `clock` is its retention date — the stored one, or an unused card's computed expiry.
 * Never sooner than DELETION_NOTICE_DAYS after its notice (or after now, when not yet told).
 */
export function deletesAt(r: RetentionRow, clock: Date | string | null | undefined, now = new Date()): Date | null {
    if (r.purgedAt || r.libraryKeptAt || !clock) return null;
    const base = new Date(clock);
    if (Number.isNaN(base.getTime())) return null;
    if (isSafetyRejected(r)) return base;
    const toldAt = r.deletionWarnedAt ? new Date(r.deletionWarnedAt) : now;
    const earliest = new Date(toldAt.getTime() + DELETION_NOTICE_DAYS * DAY_MS);
    return base > earliest ? base : earliest;
}

/** The purge's extra conditions: not kept, and told a week ago (or safety-rejected). */
export function purgeGuard(now: Date) {
    const toldBefore = new Date(now.getTime() - DELETION_NOTICE_DAYS * DAY_MS + RUN_DRIFT_MS);
    return and(
        isNull(contentAssets.libraryKeptAt),
        sql`(${contentAssets.deletionWarnedAt} <= ${toldBefore.toISOString()}::timestamp OR (${contentAssets.status} = 'rejected' AND coalesce(btrim(${contentAssets.rejectionReason}), '') <> ''))`,
    );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const longDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

/**
 * Tell each owner about their files due within DELETION_NOTICE_DAYS, once per file, and stamp
 * deletion_warned_at. Run by content-retention.ts BEFORE its purge. Returns files told about.
 */
export async function warnExpiringFiles(db: Db, now = new Date()): Promise<number> {
    const horizon = new Date(now.getTime() + DELETION_NOTICE_DAYS * DAY_MS);
    const due = await db.select({
        id: contentAssets.id, userId: contentAssets.userId, status: contentAssets.status,
        rejectionReason: contentAssets.rejectionReason, retentionDeleteAfter: contentAssets.retentionDeleteAfter,
    }).from(contentAssets).where(and(
        isNotNull(contentAssets.retentionDeleteAfter),
        lte(contentAssets.retentionDeleteAfter, horizon),
        isNull(contentAssets.deletionWarnedAt),
        isNull(contentAssets.libraryKeptAt),
        isNull(contentAssets.purgedAt),
    ));
    const told = due.filter((r) => !isSafetyRejected(r));
    if (!told.length) return 0;

    const byUser = new Map<number, typeof told>();
    for (const r of told) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
    for (const [userId, rows] of byUser) {
        // Stamp first: a failed notification must not leave the file deletable without a notice,
        // and it is never deleted sooner than a week after this stamp anyway.
        await db.update(contentAssets).set({ deletionWarnedAt: now, updatedAt: now })
            .where(sql`${contentAssets.id} IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})`);
        const first = rows.map((r) => deletesAt({ ...r, deletionWarnedAt: now }, r.retentionDeleteAfter, now))
            .filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? horizon;
        await createNotification(db as never, 'library_files_expiring', {
            userId,
            category: 'suggested_action',
            context: { files: { count: plural(rows.length, 'file', 'files'), date: longDate(first) } },
            metadata: { expiring: true, assetIds: rows.map((r) => r.id).slice(0, 200), deleteOn: first.toISOString() },
        });
    }
    console.log(`[Retention] Told ${byUser.size} owner(s) about ${told.length} file(s) due for deletion.`);
    return told.length;
}

/** Bytes this workspace stores, and its plan's allowance (null = unlimited). Never throws. */
export async function storageMeter(db: Db, orgId: number | null | undefined): Promise<{ usedBytes: number; limitBytes: number | null } | null> {
    if (!orgId) return null;
    try {
        const [lib, other, plan] = await Promise.all([
            db.select({ storageKey: contentAssets.storageKey, fileSize: contentAssets.fileSize }).from(contentAssets)
                .where(and(eq(contentAssets.organisationId, orgId), isNull(contentAssets.purgedAt), isNotNull(contentAssets.storageKey))),
            // Brand files and other uploads counted by storage-confirm-upload.ts (not content_assets).
            db.select({ usedBytes: storageUsage.usedBytes }).from(storageUsage).where(eq(storageUsage.organisationId, orgId)).limit(1),
            db.select({ limitBytes: masterPlans.storageLimitBytes }).from(plans)
                .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active'))).limit(1),
        ]);
        // A shared music-library track is one file for every workspace, never this one's bytes.
        const libraryBytes = lib.filter((r) => !isSharedLibraryKey(r.storageKey)).reduce((n, r) => n + (Number(r.fileSize) || 0), 0);
        return { usedBytes: libraryBytes + (Number(other[0]?.usedBytes) || 0), limitBytes: plan[0]?.limitBytes ?? null };
    } catch (err) {
        console.error('[library-retention] storage meter failed (non-fatal)', err);
        return null;
    }
}
