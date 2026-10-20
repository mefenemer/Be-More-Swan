// src/utils/blog-readers.ts
// "How many people are reading my blog?" — the Readers panel under the Blog Writer's KPI cards.
//
// Two audiences, kept apart on purpose:
//   · Your blog — blog_engagement_stats, from the anonymous beacon on the embedded widget and the
//     hosted permalink (widget.js, blog-seo.ts). `views` there is one per measured read.
//   · The Swan Index — swan_index_posts.view_count / read_count, from the article beacon
//     (swan-index/reads.ts). A "read" there is a view that stayed 15s or scrolled past halfway.
// They are never summed into one "total readers": the two are measured differently and a reader may
// well have seen both. Each is shown with its own label.
//
// ⚠️ Lifetime figures. Neither source keeps a per-day history, so there is no window to apply — the
// panel says "since tracking began" rather than borrowing the KPI cards' "Last 90 days".
// ⚠️ "Measured reads", never "all readers": a reader with JavaScript off, or one reading a copy
// the customer pasted into their own CMS, is never counted.

import { and, desc, eq, sql } from 'drizzle-orm';
import { blogEngagementStats, blogPosts, swanIndexPosts, swanIndexProfiles } from '../../db/schema';
import { PUBLIC_STATUSES } from './swan-index/queries';
import { articlePath } from './swan-index/render';
import { swanIndexBaseUrl } from './swan-index/base-url';

export interface BlogReaderRow {
    id: number;
    title: string;
    publishedAt: string | null;
    /** Measured reads on the customer's own blog (widget + hosted page). */
    blogReads: number;
    /** Average seconds per measured read on their blog, or null with no reads. */
    avgReadSeconds: number | null;
    /** null when the post is not on The Swan Index at all. */
    swan: { views: number; reads: number; url: string | null; status: string } | null;
}

export interface BlogReaders {
    totals: { blogReads: number; swanViews: number; swanReads: number; postsOnSwan: number };
    posts: BlogReaderRow[];
}

const PUBLIC = PUBLIC_STATUSES as readonly string[];

/** Pure shaping, so the rules above are testable without a database. */
export function buildBlogReaders(rows: Array<{
    id: number; title: string; publishedAt: Date | string | null;
    views: number | null; dwellMs: number | null;
    swanStatus: string | null; swanSection: string | null; swanViews: number | null; swanReads: number | null;
    handle: string | null; swanSlug: string | null;
}>, swanBase = swanIndexBaseUrl()): BlogReaders {
    const posts: BlogReaderRow[] = rows.map((r) => {
        const views = Number(r.views || 0);
        const onSwan = r.swanStatus != null;
        // Linked only where a reader could actually open it: public and sectioned.
        const linkable = onSwan && PUBLIC.includes(r.swanStatus!) && !!r.swanSection && !!r.handle && !!r.swanSlug;
        return {
            id: r.id,
            title: r.title,
            publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
            blogReads: views,
            avgReadSeconds: views > 0 ? Math.round(Number(r.dwellMs || 0) / 1000 / views) : null,
            swan: onSwan ? {
                views: Number(r.swanViews || 0),
                reads: Number(r.swanReads || 0),
                url: linkable ? `${swanBase.replace(/\/+$/, '')}${articlePath(r.handle!, r.swanSlug!)}` : null,
                status: r.swanStatus!,
            } : null,
        };
    });
    return {
        totals: {
            blogReads: posts.reduce((n, p) => n + p.blogReads, 0),
            swanViews: posts.reduce((n, p) => n + (p.swan?.views || 0), 0),
            swanReads: posts.reduce((n, p) => n + (p.swan?.reads || 0), 0),
            postsOnSwan: posts.filter((p) => p.swan).length,
        },
        posts,
    };
}

/** This assistant's published posts with both audiences' counts, most-read first. */
export async function loadBlogReaders(db: any, orgId: number, assistantId: number, limit = 50): Promise<BlogReaders> {
    const rows = await db
        .select({
            id: blogPosts.id,
            title: blogPosts.title,
            publishedAt: blogPosts.publishedAt,
            views: blogEngagementStats.views,
            dwellMs: blogEngagementStats.sumDwellMs,
            swanStatus: swanIndexPosts.status,
            swanSection: swanIndexPosts.section,
            swanViews: swanIndexPosts.viewCount,
            swanReads: swanIndexPosts.readCount,
            swanSlug: swanIndexPosts.slug,
            handle: swanIndexProfiles.handle,
        })
        .from(blogPosts)
        .leftJoin(blogEngagementStats, eq(blogEngagementStats.blogPostId, blogPosts.id))
        .leftJoin(swanIndexPosts, eq(swanIndexPosts.blogPostId, blogPosts.id))
        .leftJoin(swanIndexProfiles, eq(swanIndexProfiles.id, swanIndexPosts.profileId))
        .where(and(
            eq(blogPosts.organisationId, orgId),
            eq(blogPosts.assistantId, assistantId),
            eq(blogPosts.status, 'published'),
        ))
        .orderBy(
            desc(sql`COALESCE(${blogEngagementStats.views}, 0) + COALESCE(${swanIndexPosts.viewCount}, 0)`),
            desc(blogPosts.publishedAt),
        )
        .limit(limit);
    return buildBlogReaders(rows);
}

/**
 * The same figures as text for the Blog Writer's chat (content-snapshot.ts), so "how many people
 * read my blog?" is answered from the numbers on the Readers panel rather than guessed. Same
 * wording rules: measured reads, two audiences never summed, lifetime.
 */
export function renderReadersForChat(r: BlogReaders, top = 10): string {
    if (!r.posts.length) return 'READERS: none of this assistant\'s articles is published yet, so there are no reader figures.';
    const t = r.totals;
    const head = [
        'READERS (the "Readers" panel under the Performance Metrics cards on this assistant\'s page; lifetime, since tracking began; measured reads only — readers with JavaScript off, or copies pasted elsewhere, are not counted):',
        `- On the user's own blog: ${t.blogReads} measured reads.`,
        t.postsOnSwan
            ? `- On The Swan Index: ${t.swanViews} views, ${t.swanReads} of them engaged (15s+ or past halfway). Counted separately — never add the two together as "total readers".`
            : '- Not on The Swan Index.',
    ];
    const lines = r.posts.slice(0, top).map((p) => `- "${p.title}": ${p.blogReads} reads${p.avgReadSeconds != null ? `, avg ${p.avgReadSeconds}s` : ''}`
        + (p.swan ? `; Swan Index ${p.swan.views} views` : ''));
    const more = r.posts.length > top ? `\n(${r.posts.length - top} more published articles not listed.)` : '';
    return `${head.join('\n')}\nMost read:\n${lines.join('\n')}${more}`;
}
