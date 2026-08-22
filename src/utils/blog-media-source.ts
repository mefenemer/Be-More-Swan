// src/utils/blog-media-source.ts — sourcing pictures for a blog post that nobody has opened yet.
//
// Phase 5 of docs/blog-media-composition-plan.md, and the piece the blog side of the layout IR was
// waiting on. The rest of the media pipeline is built and shipped: the `:::media` directive, the
// sanitiser allowlist, the src-less snapshot, the widget resolver, the Studio picker, drag-and-drop.
// What did not exist was an entry point a DRAFTING run could use — every stock path went through
// `attachPexelsImageToPost`, which is `scheduledPosts`-scoped, so a blog post could only ever get a
// picture from a human clicking one.
//
// ── ⚠️ Why a picture must never fail a draft ────────────────────────────────────────────────────
// Everything here is best-effort and returns null rather than throwing. The body is the expensive
// artifact — it is a model call the customer has already paid for, and on the autopilot path it is
// a queued job whose retry would redraft the whole post. A stock search that rate-limits, an org
// with no PEXELS_API_KEY, a search that finds nothing: all of those are a post with one fewer
// picture, never a post that does not exist. Same rule as generateBlogSeo's best-effort call in
// process-blog-jobs.ts.
//
// ── What this is NOT ────────────────────────────────────────────────────────────────────────────
// Not the social media resolver (src/utils/media-resolver.ts). That one owns a manual → stock → ai
// priority matrix, cross-post fan-out and the never-reuse rule, all of it keyed on scheduled posts.
// A blog draft wants one specific picture for one specific paragraph, described by the drafter, and
// nothing else in the matrix applies. Sharing the entry point would mean teaching the matrix about
// a surface that does not have posts.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPostAssets, blogPosts } from '../../db/schema';
import { createPexelsAsset, searchUniqueImages } from './pexels';

type Db = ReturnType<typeof getDb>;

/**
 * How many pictures one drafting run may source.
 *
 * ⚠️ A cap, not a target. Each one is a Pexels search plus an asset row, on a path that also runs
 * unattended from the autopilot cron — and a post that opens with six stock photographs reads like
 * a content farm whatever the words say. The prompt asks for at most two; this is the backstop for
 * a model that asks for nine.
 */
export const MAX_SOURCED_IMAGES = 3;

export interface SourcedImage {
    assetId: number;
    /** For the caller's warnings — "we found you a picture" is worth saying, quietly. */
    query: string;
}

/**
 * Find one stock image for `query` and attach it to the post's inline media.
 *
 * Returns the new asset id, or null if nothing usable was found. `dedup: false` because the
 * never-reuse rule is a social-feed guarantee (posted_assets) that a blog post does not share —
 * the existing blog hero path already opts out for the same reason.
 */
async function sourceOne(
    db: Db,
    args: { blogPostId: number; organisationId: number; userId: number; query: string },
): Promise<number | null> {
    const { blogPostId, organisationId, userId, query } = args;
    // ⚠️ `keywords` supplied, so no model call: the drafting model already wrote these words as the
    // image node's `query`, and re-deriving them would be an LLM round trip per picture.
    const { candidates } = await searchUniqueImages(db, organisationId, query, {
        limit: 1, dedup: false, keywords: query,
    });
    const candidate = candidates[0];
    if (!candidate) return null;

    const assetId = await createPexelsAsset(db, {
        userId, orgId: organisationId, candidate, assetType: 'image',
    });

    // Append after the current last position, and idempotent on the (post, asset) unique key —
    // the same attach the Studio's picker performs, so a sourced picture behaves like a chosen one
    // everywhere downstream (the media panel, detach, the syndication strip).
    const existing = await db.select({ position: blogPostAssets.position })
        .from(blogPostAssets).where(eq(blogPostAssets.blogPostId, blogPostId));
    const nextPos = existing.reduce((max, r) => Math.max(max, r.position + 1), 0);
    await db.insert(blogPostAssets)
        .values({ blogPostId, contentAssetId: assetId, position: nextPos })
        .onConflictDoNothing();

    return assetId;
}

/**
 * Source a picture for each of `queries`, in order, for one blog post.
 *
 * Returns an array the same length as the input, holding an asset id or null per query — position
 * matters, because the caller maps these back onto the image nodes of a layout by index.
 *
 * ⚠️ SEQUENTIAL, not parallel. Pexels rate-limits per key, and the searches share a cache table;
 * three concurrent misses for one draft is the shape that trips the limit for everybody else in the
 * account. Three pictures is at most three quick requests — nobody is waiting on this that is not
 * already waiting on a two-thousand-token generation.
 */
export async function sourceBlogImages(
    db: Db,
    args: { blogPostId: number; organisationId: number; userId: number; queries: string[] },
): Promise<(number | null)[]> {
    const { blogPostId, organisationId, userId } = args;
    const queries = args.queries.slice(0, MAX_SOURCED_IMAGES);
    if (!queries.length) return [];

    // No key, no stock. Checked once rather than failing three searches in a row, and it is a
    // perfectly ordinary state — a self-hosted or air-gapped deployment has no Pexels account.
    if (!process.env.PEXELS_API_KEY) return queries.map(() => null);

    // The post must exist in this organisation before anything is attached to it. Cheap, and it is
    // the tenant boundary: everything below writes rows keyed on blogPostId.
    const [post] = await db
        .select({ id: blogPosts.id })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, blogPostId), eq(blogPosts.organisationId, organisationId)))
        .limit(1);
    if (!post) return queries.map(() => null);

    const out: (number | null)[] = [];
    for (const query of queries) {
        try {
            out.push(query.trim() ? await sourceOne(db, { blogPostId, organisationId, userId, query: query.trim() }) : null);
        } catch (err) {
            // Rate limits, a provider outage, a malformed candidate — one fewer picture.
            console.error('[blog-media-source] could not source an image', { blogPostId, query }, err);
            out.push(null);
        }
    }
    return out;
}
