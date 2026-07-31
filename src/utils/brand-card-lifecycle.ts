// src/utils/brand-card-lifecycle.ts
// The lifecycle rule for auto-generated brand cards, in ONE place.
//
// ── The problem this settles ────────────────────────────────────────────────────────────────────
// Both creation paths make a card FOR a specific post — renderAndPersistBrandCard (drafting) and
// edit-brand-card (review-time re-render). Neither is a library upload. But content-assets.ts (GET)
// lists every content_assets row the user owns, so the card lands in "My Content" as a reusable
// asset and stays there for ever: nothing ever set retention_delete_after on it, so
// content-retention.ts never reclaimed it. Measured on prod 2026-07-31, 26 of the 30 rows with real
// R2 bytes were brand cards — effectively the entire footprint of post media.
//
// ── The rule ────────────────────────────────────────────────────────────────────────────────────
// A brand card that was NEVER attached to a post and has NEVER been opened in the card editor is
// removed 30 days after it was generated. Everything else is permanent:
//
//   • Attached to a post (ever, in any status) → not "unused". Its media follows the post's own
//     retention (posted 30d / rejected 7d), which already exists.
//   • Opened and saved in the card editor, or explicitly Kept from My Content → libraryKeptAt is
//     stamped and the card is exempt for good. This is the half of the rule that matters: a card
//     someone hand-adjusted must never disappear under them.
//
// Machine-generated and untouched is the only case that expires, and it is fully reproducible
// anyway — renderParams stores headline + variant + kit + layout, and the kit is snapshotted whole
// so a re-render cannot be restyled by a later kit change.
//
// ── Why both readers import from here ───────────────────────────────────────────────────────────
// content-assets.ts shows the countdown; content-retention.ts does the purge. If those two computed
// eligibility separately they would drift, and the failure mode is the worst one available: a card
// with no countdown that vanishes anyway, or a countdown that never fires. One predicate, one
// window, one definition of "ever attached".

import { inArray } from 'drizzle-orm';
import { scheduledPosts, scheduledPostAssets } from '../../db/schema';

/** How long an unused, never-edited generated card survives. Stated to the user verbatim. */
export const BRAND_CARD_UNUSED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** The user-visible wording of the rule. Kept next to the number so they cannot drift apart. */
export const BRAND_CARD_UNUSED_RETENTION_COPY =
    'Unused generated cards are removed 30 days after they are created. Keeping or editing one makes it permanent.';

export const BRAND_CARD_PROVIDER = 'brand_card';

/** The subset of a content_assets row this module needs. Deliberately structural — both callers
 *  pass full Drizzle rows, and neither should have to reshape one to ask a question about it. */
export type BrandCardLifecycleRow = {
    id: number;
    provider: string | null;
    createdAt: Date;
    purgedAt?: Date | null;
    libraryKeptAt?: Date | null;
};

/**
 * Every asset id in `assetIds` that is referenced by ANY post — junction row or the legacy
 * scheduledPosts.contentAssetIds jsonb array, in any status.
 *
 * "Any status" is deliberate and wider than findActivePostsByAsset's RELEVANT_POST_STATUSES: this
 * question is "was this card ever used for something", not "is it in use now". A card attached to a
 * post that was later cancelled is still work the user directed, and must not expire as though the
 * platform had generated it into a void.
 *
 * Both storage shapes have to be read. The junction is the source of truth for new writes, but
 * publish-social-posts.ts and the drafting resolver still write the legacy array, and a card
 * attached only through the array would otherwise read as never-used and be purged out from under a
 * live post. The array is intersected in JS rather than with a jsonb containment operator for the
 * same reason findActivePostsByAsset does it: there is no index on that column and no FK to lean
 * on, so the honest implementation is a scoped scan.
 */
export async function findEverAttachedAssetIds(
    db: any,
    orgIds: number[],
    assetIds: number[],
): Promise<Set<number>> {
    const attached = new Set<number>();
    if (assetIds.length === 0 || orgIds.length === 0) return attached;

    const wanted = new Set(assetIds);

    const junction = await db.select({ contentAssetId: scheduledPostAssets.contentAssetId })
        .from(scheduledPostAssets)
        .where(inArray(scheduledPostAssets.contentAssetId, assetIds));
    for (const row of junction) attached.add(row.contentAssetId);

    const posts = await db.select({ contentAssetIds: scheduledPosts.contentAssetIds })
        .from(scheduledPosts)
        .where(inArray(scheduledPosts.organisationId, orgIds));
    for (const post of posts) {
        const linked = Array.isArray(post.contentAssetIds) ? post.contentAssetIds : [];
        for (const id of linked) {
            const n = Number(id);
            if (wanted.has(n)) attached.add(n);
        }
    }

    return attached;
}

/**
 * Is this row a generated card on the expiry clock?
 *
 * `everAttached` comes from findEverAttachedAssetIds — passed in rather than looked up so the
 * predicate stays pure and one query can answer for a whole page of assets.
 */
export function isExpiringBrandCard(row: BrandCardLifecycleRow, everAttached: boolean): boolean {
    if (row.provider !== BRAND_CARD_PROVIDER) return false;
    if (row.purgedAt) return false;
    // The exemption. Stamped by edit-brand-card on save and by the Keep action in My Content —
    // either way it means a human touched this card, and a human's card is not transient media.
    if (row.libraryKeptAt) return false;
    return !everAttached;
}

/** When this card will be removed, or null if it is not on the clock. */
export function brandCardExpiresAt(row: BrandCardLifecycleRow, everAttached: boolean): Date | null {
    if (!isExpiringBrandCard(row, everAttached)) return null;
    return new Date(new Date(row.createdAt).getTime() + BRAND_CARD_UNUSED_RETENTION_MS);
}
