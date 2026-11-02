// src/utils/awaiting-review.ts
//
// ONE definition of "a social post waiting for your review", for every count of it.
//
// The Review Queue (get-social-drafts) and the per-assistant "Needs you" number on the Dashboard and
// My Assistants (get-assistants opSignals.pendingReview) used to count this two ways: the queue took
// pending_approval + in_review + a manual draft someone had put work into, one per CARD (a cross-post
// is one card); the assistant count took pending_approval ROWS only, one per platform. So one
// workspace read "62 Felix · Posts" on the Dashboard and 83 social posts in Review (SWAN-4,
// 2026-11-01). Both now read from here.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { scheduledPosts } from '../../db/schema';
import { AWAITING_REVIEW_STATUSES } from '../config/post-status';

/**
 * A 'draft' someone actually built. The composer creates its row BLANK and stamps it 'draft', which
 * belongs nowhere; once it has a caption or media it is work awaiting review, and is shown as such.
 * A blank one stays hidden (archive-cleanup sweeps it, and that sweep requires no media).
 */
export function contentfulDraft() {
    return and(
        eq(scheduledPosts.status, 'draft'),
        or(
            sql`btrim(coalesce(${scheduledPosts.caption}, '')) <> ''`,
            sql`EXISTS (SELECT 1 FROM scheduled_post_assets spa WHERE spa.scheduled_post_id = ${scheduledPosts.id})`,
            sql`jsonb_typeof(${scheduledPosts.contentAssetIds}) = 'array' AND jsonb_array_length(${scheduledPosts.contentAssetIds}) > 0`,
        ),
    );
}

/** Every status the Review Queue's "To approve" column lists, plus contentful drafts. */
export function awaitingReview() {
    return or(inArray(scheduledPosts.status, [...AWAITING_REVIEW_STATUSES] as string[]), contentfulDraft());
}

/** One per card: a cross-post's platform rows share a group and count once. Same key as _rqGroupKey. */
export const reviewCardKey = sql`coalesce('g:' || ${scheduledPosts.crosspostGroupId}, 'id:' || ${scheduledPosts.id}::text)`;
