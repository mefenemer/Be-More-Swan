// src/utils/blog-list-paging.ts
// Paging for the public blog list — the rules, kept out of the endpoint so they are unit-testable
// without a request, and so a second caller (the RSS feed, a sitemap, the SEO bake) cannot invent
// a different set.
//
// ── Why keyset and not OFFSET ──────────────────────────────────────────────────────────────────
// The list is newest-first and a blog publishes while people are reading it. Under OFFSET, a post
// published between page 1 and page 2 shifts every later row down one: the reader sees the last
// item of page 1 again at the top of page 2, and the oldest post on the final page falls off
// entirely. Keyset asks "what sorts after this row", which is stable under inserts.
//
// ── Why the cursor is an ID and never a date ───────────────────────────────────────────────────
// The comparison reads the sort key back out of the row itself, inside the query. So no timestamp
// makes the round trip through a query string: nothing to format, no timezone to lose in the
// parse, and no way for a caller to hand us a date that reorders someone else's blog.

import { sql } from 'drizzle-orm';
import { blogPosts } from '../../db/schema';

/**
 * The default page size, and it is deliberately the value the endpoint used BEFORE it could page.
 *
 * widget.js is served from one origin and embedded on customer sites, so at any moment some
 * visitors are running a cached copy that sends no `limit` and expects a single un-paged response.
 * Defaulting to something smaller would silently shorten every blog already embedded out there the
 * moment this deploys. New clients ask for a page size and follow nextCursor.
 */
export const DEFAULT_PAGE_SIZE = 50;

/** Ceiling on what one request may ask for. Paging exists so callers walk, not so they scrape. */
export const MAX_PAGE_SIZE = 50;

/**
 * ⚠️ COALESCE, because published_at is NULLABLE and created_at is not.
 *
 * blog-publish.ts always stamps published_at, so in practice it is set — but "in practice" is the
 * wrong guarantee to hang paging on. A NULL sort key does not merely sort oddly: every keyset
 * comparison against NULL evaluates to NULL, so the row drops out of every page after the first.
 * The post would exist, serve fine at its own URL, and be permanently unreachable from the list.
 */
export const listSortKey = sql`COALESCE(${blogPosts.publishedAt}, ${blogPosts.createdAt})`;

/**
 * "Sorts strictly after the cursor row" — the row being looked up by id, inside the same query.
 *
 * ⚠️ The subselect repeats the outer query's org and status filters on purpose. An id belonging to
 * another workspace, or to a draft, matches nothing; the comparison yields NULL; the caller gets an
 * empty page. Without those filters this cursor becomes an oracle: pass a stranger's post id and
 * the shape of the response tells you where their unpublished work sorts in time.
 */
export function afterCursor(cursorId: number, orgId: number) {
    return sql`(COALESCE(${blogPosts.publishedAt}, ${blogPosts.createdAt}), ${blogPosts.id}) < (
        SELECT COALESCE(c.published_at, c.created_at), c.id
          FROM blog_posts c
         WHERE c.id = ${cursorId} AND c.organisation_id = ${orgId} AND c.status = 'published'
    )`;
}

/** A page size from an untrusted query string: a positive whole number, capped; anything else is the default. */
export function pageSize(raw: string | null | undefined): number {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

/** A cursor from an untrusted query string, or null. Validity beyond "a positive id" is the query's job. */
export function parseCursor(raw: string | null | undefined): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Split a `size + 1` result into the page and the cursor that follows it.
 *
 * Callers fetch ONE more row than they intend to return — that extra row is the whole answer to
 * "is there another page?", and it costs nothing next to a second COUNT over the table.
 *
 * `nextCursor` is null rather than absent on the last page: an explicit "no more" is what stops a
 * client looping, and `undefined` serialises to a missing key that reads the same as a bug.
 */
export function takePage<T extends { id: number }>(rows: T[], size: number): { page: T[]; nextCursor: string | null } {
    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    return { page, nextCursor: hasMore ? String(page[page.length - 1].id) : null };
}
