// netlify/functions/archive-cleanup.ts
// Review Queue → Archive lifecycle. Two independent sweeps, one daily run (netlify.toml, 04:00 UTC):
//
//
//   1. Rejected posts are kept for 30 days, then hard-deleted.
//   2. Abandoned blank drafts are collected after 7 days — see sweepAbandonedBlanks below.
//
// Both release their media to the content-retention pipeline (which reclaims the R2 objects) and log
// a per-org summary to admin_audit_log.
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

/** Rows collected per run, shared across both sweeps below. */
const BATCH_LIMIT = 500;

/**
 * How long an untouched blank draft is kept before it is collected.
 *
 * Generous on purpose: the row is invisible on every surface (see below), so nobody is waiting on
 * its removal, and the only cost of waiting longer is a row. The cost of being too eager is deleting
 * a composer someone left open over a long weekend.
 */
const BLANK_DRAFT_RETENTION_DAYS = 7;

// There is deliberately no sweep for the legacy `status:'draft'` clones reject-post used to leave
// behind (it stopped on 2026-07-31; a revision is now a real generation job landing at
// 'pending_approval'). One was written and then removed: introspected 2026-08-05, BOTH staging and
// prod hold zero rows matching `status='draft' AND is_revised`, so it was a daily query against a
// set proven empty and pinned to a boundary in the past, i.e. one that could never grow again.
// If a stray clone ever turns up, delete it by hand rather than reviving a permanent sweep for it.

type Db = ReturnType<typeof getDb>;
type Sweepable = { id: number; organisationId: number | null };

/**
 * Collect abandoned blank drafts.
 *
 * ── What a blank is ─────────────────────────────────────────────────────────────────────────────
 * "Create Post" opens the three-pane editor, and the editor edits a ROW — so create-manual-post.ts
 * inserts one up front with no caption, no media and no platform commitment, at status 'draft'
 * (deliberately not 'pending_approval', which would put an empty card in the Review Queue). If the
 * user closes the tab instead of writing anything, that row is all that is left of the gesture.
 *
 * ── Why they needed collecting ──────────────────────────────────────────────────────────────────
 * Nothing deleted them. The only two deletes on scheduled_posts anywhere were this function's
 * rejected sweep and set-post-platforms' de-selection, so blanks accumulated for the life of the
 * account. (`cleanup-abandoned-drafts.ts` reads like it already did this and does not — it works on
 * onboarding_drafts, partial ASSISTANT SETUPS, a different table entirely.)
 *
 * Worth being clear about what this is NOT fixing, so nobody widens it expecting more: a blank holds
 * a posting slot for about a day and then stops. schedule-gap-fill counts 'draft' as coverage only
 * within `publish_date >= now`, and create-manual-post stamps a `now + 24h` placeholder, so the row
 * suppresses one day's slot and then ages out of the filter permanently. This sweep is row hygiene.
 *
 * ── The safety rule ─────────────────────────────────────────────────────────────────────────────
 * A row is swept only when it demonstrably holds no human work: no caption, no hashtags, and no
 * media by EITHER reference (the junction table and the deprecated content_asset_ids array — reading
 * one and not the other is how post media went unreclaimed for months; see release-post-media.ts).
 *
 * Note what is deliberately not used: `updated_at`. It looks like the natural "abandoned" signal and
 * it is not trustworthy here — it only moves when a writer explicitly sets it, and there are ~30
 * functions that update scheduled_posts. `created_at` is immutable and always set, so an age gate
 * built on it cannot silently under-report activity. Emptiness is the real test; age only keeps us
 * away from a composer that is open right now.
 *
 * Cross-post groups are all-or-nothing. One composer with three destinations is three rows sharing a
 * crosspost_group_id, and set-post-platforms fans out more later carrying `status: anchor.status`.
 * Sweeping a group member-by-member could delete the empty siblings of a post someone had started,
 * so a group is swept only when EVERY member qualifies on its own.
 */
async function sweepAbandonedBlanks(db: Db, now: Date, limit: number): Promise<Sweepable[]> {
    if (limit <= 0) return [];
    const cutoff = new Date(now.getTime() - BLANK_DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // `untouched` is every row that qualifies ON ITS OWN. The outer query then keeps only those whose
    // whole cross-post group is inside that set, which is what makes the group check all-or-nothing
    // without restating the emptiness predicate a second time and letting the two drift.
    //
    // jsonb_typeof guards the array read: content_asset_ids is a plain jsonb column with no shape
    // constraint, and jsonb_array_length() on a non-array ERRORS rather than returning 0 — which
    // would abort the whole sweep over one malformed row.
    const rows = await db.execute<{ id: number; organisation_id: number | null }>(sql`
        WITH untouched AS (
            SELECT sp.id, sp.organisation_id, sp.crosspost_group_id
            FROM scheduled_posts sp
            WHERE sp.status = 'draft'
              -- toISOString(), never the Date: postgres-js binds a raw template's values as-is and
              -- throws ERR_INVALID_ARG_TYPE in Bind, client-side, before the statement is sent.
              -- (No backticks in this comment: it lives INSIDE a template literal, and one would end
              -- the string. That is what broke the build the first time this note was written.)
              -- It hid from tests/raw-sql-date-params.test.ts for a different reason than the lead
              -- sweep did: that lint matched only the .execute(sql ...) shape, and the TYPE GENERIC
              -- on db.execute<{...}>( broke the match. Both shapes are covered now.
              AND sp.created_at < ${cutoff.toISOString()}
              AND btrim(coalesce(sp.caption, '')) = ''
              AND btrim(coalesce(sp.hashtags, '')) = ''
              AND (
                  sp.content_asset_ids IS NULL
                  OR jsonb_typeof(sp.content_asset_ids) <> 'array'
                  OR jsonb_array_length(sp.content_asset_ids) = 0
              )
              AND NOT EXISTS (
                  SELECT 1 FROM scheduled_post_assets spa
                  WHERE spa.scheduled_post_id = sp.id
              )
        )
        SELECT u.id, u.organisation_id
        FROM untouched u
        WHERE u.crosspost_group_id IS NULL
           OR NOT EXISTS (
              SELECT 1 FROM scheduled_posts sib
              WHERE sib.crosspost_group_id = u.crosspost_group_id
                AND sib.id NOT IN (SELECT id FROM untouched)
           )
        -- The cap can cut an all-blank group in half. Self-healing rather than harmful: every member
        -- is empty by construction, and a survivor whose siblings are gone still qualifies on its
        -- own next run, so the group finishes draining the following day.
        LIMIT ${limit}
    `);

    return [...rows].map(r => ({ id: r.id, organisationId: r.organisation_id }));
}

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
        .limit(BATCH_LIMIT);

    // The blank sweep runs on whatever budget the archive sweep left. Sharing one cap keeps a single
    // run's blast radius the same as it has always been; a backlog drains over consecutive days
    // rather than in one very large transaction.
    //
    // No early return when `expired` is empty any more — that used to skip everything below it, and
    // the blank sweep has to run on the (common) day when nothing is due for archiving.
    const blanks = await sweepAbandonedBlanks(db, now, BATCH_LIMIT - expired.length);

    const collected = [...expired, ...blanks];
    if (!collected.length) {
        return { statusCode: 200, body: JSON.stringify({ deleted: 0, blanksDeleted: 0 }) };
    }

    // Release the media so content-retention reclaims the R2 objects after its 7-day window.
    // MUST run before the delete below: scheduled_post_assets cascades on post delete, and once
    // those rows are gone nothing can discover which assets these posts held.
    //
    // Best-effort — a storage bookkeeping failure must never strand a post in the archive forever —
    // but logged rather than swallowed, because a silent catch is how the previous version of this
    // step stayed broken.
    //
    // Runs over `collected` rather than `expired` even though a blank has no media by the definition
    // that selected it. The redundancy is deliberate: it costs nothing today and it is what keeps the
    // release correct if that emptiness predicate is ever loosened.
    const ids = collected.map(p => p.id);
    let releasedAssets = 0;
    try {
        releasedAssets = await releasePostMedia(db, ids);
    } catch (err) {
        console.error('[archive-cleanup] media release failed (posts still deleted):', err);
    }

    // Hard-delete everything collected.
    await db.delete(scheduledPosts).where(inArray(scheduledPosts.id, ids));

    // Per-org summary for the admin audit log.
    const summary: Record<number, number> = {};
    for (const p of collected) {
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
            blankDraftRetentionDays: BLANK_DRAFT_RETENTION_DAYS,
            deletedByOrg: summary,
            deletedCount: ids.length,
            // Broken out because they answer different questions: `archivedCount` is the expected
            // steady state, a `blanksDeleted` that never falls says the composer is leaking rows.
            archivedCount: expired.length,
            blanksDeleted: blanks.length,
            releasedAssets,
        },
        ipAddress: 'scheduled',
    }).catch(() => {});

    console.log(
        `[archive-cleanup] deleted=${ids.length} (archived=${expired.length} past ${ARCHIVE_RETENTION_DAYS}d, ` +
        `blanks=${blanks.length} past ${BLANK_DRAFT_RETENTION_DAYS}d), releasedAssets=${releasedAssets}`
    );
    return {
        statusCode: 200,
        body: JSON.stringify({
            deleted: ids.length,
            archived: expired.length,
            blanksDeleted: blanks.length,
            releasedAssets,
        }),
    };
});
