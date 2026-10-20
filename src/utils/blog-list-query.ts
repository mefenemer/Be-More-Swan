// src/utils/blog-list-query.ts
// One page of a workspace's PUBLISHED posts, newest first — the query behind every public list.
//
// Two callers render this list: widget-api.ts (the JSON the embedded widget pages through) and
// blog-page.ts (the hosted, server-rendered index at /b/:key). They used to be one caller; the query
// moved here so the second one could not drift into a different filter, order or thumbnail rule —
// a post visible in the widget and missing from the hosted index is exactly the bug two copies grow.
//
// The paging RULES (sort key, keyset cursor, size caps) live in blog-list-paging.ts; this module
// only runs them.

import { and, desc, eq, sql } from 'drizzle-orm';
import { blogPosts } from '../../db/schema';
import { listSortKey, afterCursor, takePage } from './blog-list-paging';
import { resolveCardImageUrls } from './blog-media-resolve';
import { cardImageRef } from './blog-card-image';
import { isAiAssisted } from './blog-ai-assisted';
import { monthLabel, NO_FILTER, type BlogFacets, type BlogListFilter } from './blog-filters';

/** The reader's category / month filter as WHERE clauses. Values are bound, never interpolated. */
function filterClauses(filter: BlogListFilter) {
    return [
        ...(filter.tag ? [sql`${blogPosts.tags} @> ${JSON.stringify([filter.tag])}::jsonb`] : []),
        ...(filter.month ? [sql`to_char(${listSortKey}, 'YYYY-MM') = ${filter.month}`] : []),
    ];
}

/**
 * What a reader can filter this blog by: every tag in use (most-used first) and every month that
 * has a post (newest first), each with its count. Over ALL published posts, not the current page,
 * so the menus do not change as the reader pages.
 */
export async function listBlogFacets(db: any, orgId: number): Promise<BlogFacets> {
    const [tagRows, monthRows] = await Promise.all([
        db.execute(sql`
            SELECT t.tag AS value, count(*)::int AS count
              FROM blog_posts p, jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.tags) = 'array' THEN p.tags ELSE '[]'::jsonb END) AS t(tag)
             WHERE p.organisation_id = ${orgId} AND p.status = 'published' AND btrim(t.tag) <> ''
             GROUP BY t.tag ORDER BY count(*) DESC, t.tag LIMIT 40`),
        db.execute(sql`
            SELECT to_char(COALESCE(p.published_at, p.created_at), 'YYYY-MM') AS value, count(*)::int AS count
              FROM blog_posts p
             WHERE p.organisation_id = ${orgId} AND p.status = 'published'
             GROUP BY 1 ORDER BY 1 DESC LIMIT 120`),
    ]);
    const rows = (r: any): any[] => (Array.isArray(r) ? r : r?.rows || []);
    return {
        categories: rows(tagRows).map((r) => ({ value: String(r.value), label: String(r.value), count: Number(r.count) })),
        months: rows(monthRows).map((r) => ({ value: String(r.value), label: monthLabel(String(r.value)), count: Number(r.count) })),
    };
}

export interface PublishedPostSummary {
    title: string;
    slug: string;
    /** meta_description, or '' — the card excerpt. */
    excerpt: string;
    tags: unknown;
    publishedAt: Date | string | null;
    aiAssisted: boolean;
    /** Fresh display URL for the card thumbnail, or null for a text-only card. */
    imageUrl: string | null;
    imageAlt: string;
}

export async function listPublishedPosts(
    db: any,
    orgId: number,
    opts: { size: number; cursorId: number | null; filter?: BlogListFilter },
): Promise<{ posts: PublishedPostSummary[]; nextCursor: string | null }> {
    const { size, cursorId } = opts;
    const filter = opts.filter || NO_FILTER;
    // `db` is untyped here (as in blog-media-resolve), so name the row shape takePage passes through.
    const rows: any[] = await db
        .select({
            // Selected for the cursor, not for the response — the id stays server-side, and
            // nextCursor is the only form of it a caller ever sees.
            id: blogPosts.id,
            title: blogPosts.title,
            slug: blogPosts.slug,
            metaDescription: blogPosts.metaDescription,
            tags: blogPosts.tags,
            publishedAt: blogPosts.publishedAt,
            jobId: blogPosts.jobId,
            blueprintId: blogPosts.blueprintId,
            isAutonomous: blogPosts.isAutonomous,
            generationReason: blogPosts.generationReason,
            // The list thumbnail, denormalised at publish time. Three small columns instead of
            // published_payload — pulling 50 full article bodies to find 50 <img> tags is the
            // reason this is a column and not a read-time parse.
            cardImageAssetId: blogPosts.cardImageAssetId,
            cardImageUrl: blogPosts.cardImageUrl,
            cardImageAlt: blogPosts.cardImageAlt,
        })
        .from(blogPosts)
        .where(and(
            eq(blogPosts.organisationId, orgId),
            eq(blogPosts.status, 'published'),
            ...(cursorId ? [afterCursor(cursorId, orgId)] : []),
            ...filterClauses(filter),
        ))
        // id DESC is not decoration: two posts published in the same second would otherwise
        // come back in whatever order the planner chose, and a keyset cursor built on an
        // ambiguous order skips or repeats rows at exactly that boundary.
        .orderBy(desc(listSortKey), desc(blogPosts.id))
        // One more than asked for, purely to answer "is there another page?" without a
        // second COUNT query over the whole table.
        .limit(size + 1);

    const { page, nextCursor } = takePage(rows, size);
    // One batched query for the whole page's images, not one per post. Every row here belongs to
    // the same org, but the resolver is org-scoped per item regardless, so an asset id pointing
    // outside the org resolves to null rather than to somebody else's picture.
    const imageUrls = await resolveCardImageUrls(db, page.map((r) => ({ orgId, ref: cardImageRef(r) })));
    const posts = page.map((r, i) => ({
        title: r.title,
        slug: r.slug,
        excerpt: r.metaDescription || '',
        tags: r.tags,
        publishedAt: r.publishedAt,
        aiAssisted: isAiAssisted(r),
        // null when the post has no usable image — a text-only card is the right look for an
        // essay, not a gap where a picture failed to load.
        imageUrl: imageUrls[i],
        imageAlt: r.cardImageAlt || r.title,
    }));
    return { posts, nextCursor };
}
