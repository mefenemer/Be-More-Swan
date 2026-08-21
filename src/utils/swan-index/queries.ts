// src/utils/swan-index/queries.ts
// The Swan Index — every read the public site performs. Kept out of the function module so the
// page renderers stay pure and these stay the only thing that touches a database.

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../../db/client';
import { swanIndexPosts, swanIndexProfiles, swanIndexSections, blogPosts } from '../../../db/schema';
import type { SwanCard, SwanSection } from './render';

type Db = ReturnType<typeof getDb>;

/** Statuses that render publicly. 'pending', 'rejected' and 'withdrawn' never leave the office. */
export const PUBLIC_STATUSES = ['live', 'featured'] as const;

export async function listSections(db: Db): Promise<SwanSection[]> {
    return db
        .select({ key: swanIndexSections.key, label: swanIndexSections.label, standfirst: swanIndexSections.standfirst })
        .from(swanIndexSections)
        .where(eq(swanIndexSections.active, true))
        .orderBy(swanIndexSections.position);
}

/**
 * The card projection.
 *
 * Joins swan_index_profiles for the byline, and swan_index_sections for the label — the row stores
 * the section KEY, and a list that printed "operations" where the masthead says "Operations" is the
 * kind of detail that makes a publication look automated, which is the one thing it cannot look.
 *
 * ⚠️ No join to blog_posts. Every field here is denormalised onto swan_index_posts precisely so the
 * front page is one indexed scan; adding a join to pick up "just one more field" would undo that
 * for every list on the site at once.
 */
const CARD_COLUMNS = {
    slug: swanIndexPosts.slug,
    title: swanIndexPosts.title,
    dek: swanIndexPosts.dek,
    section: swanIndexPosts.section,
    sectionLabel: swanIndexSections.label,
    liveAt: swanIndexPosts.liveAt,
    readCount: swanIndexPosts.readCount,
    handle: swanIndexProfiles.handle,
    displayName: swanIndexProfiles.displayName,
    roleTitle: swanIndexProfiles.roleTitle,
    companyName: swanIndexProfiles.companyName,
    siteUrl: swanIndexProfiles.siteUrl,
};

type CardRow = {
    slug: string; title: string; dek: string | null; section: string | null; sectionLabel: string | null;
    liveAt: Date | null; readCount: number;
    handle: string; displayName: string; roleTitle: string | null; companyName: string | null; siteUrl: string | null;
};

function toCard(r: CardRow): SwanCard {
    return {
        slug: r.slug,
        title: r.title,
        dek: r.dek,
        section: r.section,
        sectionLabel: r.sectionLabel,
        liveAt: r.liveAt ? r.liveAt.toISOString() : null,
        readCount: r.readCount,
        author: {
            handle: r.handle,
            displayName: r.displayName,
            roleTitle: r.roleTitle,
            companyName: r.companyName,
            siteUrl: r.siteUrl,
        },
    };
}

/** Base query: public pieces from active profiles, joined to their section label. */
function publicPosts(db: Db) {
    return db
        .select(CARD_COLUMNS)
        .from(swanIndexPosts)
        .innerJoin(swanIndexProfiles, eq(swanIndexProfiles.id, swanIndexPosts.profileId))
        .leftJoin(swanIndexSections, eq(swanIndexSections.key, swanIndexPosts.section));
}

/** A suspended or withdrawn profile takes its whole back catalogue off the site with it. */
const VISIBLE = and(
    inArray(swanIndexPosts.status, [...PUBLIC_STATUSES]),
    eq(swanIndexProfiles.status, 'active'),
);

/** The curated front page, in editorial order. `featured_rank` 1 is the lead story. */
export async function getFeatured(db: Db, limit = 7): Promise<SwanCard[]> {
    const rows = await publicPosts(db)
        .where(and(eq(swanIndexPosts.status, 'featured'), eq(swanIndexProfiles.status, 'active')))
        .orderBy(swanIndexPosts.featuredRank)
        .limit(limit);
    return (rows as CardRow[]).map(toCard);
}

/** Everything live across the network, newest first. */
export async function getLatest(db: Db, limit = 30, section?: string | null): Promise<SwanCard[]> {
    const rows = await publicPosts(db)
        .where(section ? and(VISIBLE, eq(swanIndexPosts.section, section)) : VISIBLE)
        .orderBy(desc(swanIndexPosts.liveAt))
        .limit(limit);
    return (rows as CardRow[]).map(toCard);
}

export async function getByAuthor(db: Db, profileId: number, limit = 60): Promise<SwanCard[]> {
    const rows = await publicPosts(db)
        .where(and(VISIBLE, eq(swanIndexPosts.profileId, profileId)))
        .orderBy(desc(swanIndexPosts.liveAt))
        .limit(limit);
    return (rows as CardRow[]).map(toCard);
}

export interface ArticleRow {
    swanId: number;
    blogPostId: number;
    organisationId: number;
    title: string;
    dek: string | null;
    section: string | null;
    sectionLabel: string | null;
    liveAt: Date | null;
    robots: string;
    authorCanonicalUrl: string | null;
    /** From blog_posts, read live — see the note below. */
    publishedPayload: unknown;
    sourceStatus: string;
    jobId: string | null;
    blueprintId: number | null;
    isAutonomous: boolean | null;
    generationReason: string | null;
}

/**
 * One article, by handle + slug.
 *
 * This is the ONE query that joins blog_posts, and the join is the whole design: the body is read
 * live from the source row rather than from a copy, so an author's edit shows here immediately and
 * a retraction cannot leave a stale article standing under their byline.
 *
 * `blog_posts.status = 'published'` is therefore a hard filter, not a nicety — it is the second
 * half of the retraction guarantee. unpublishBlogPost() also flips the magazine row to 'withdrawn'
 * so lists stop advertising the piece; if that write ever failed, this predicate still refuses to
 * serve it. Two independent mechanisms, because "the author took it down" must not depend on a
 * best-effort call succeeding.
 */
export async function getArticle(db: Db, handle: string, slug: string): Promise<{ row: ArticleRow; profileId: number } | null> {
    const [row] = await db
        .select({
            swanId: swanIndexPosts.id,
            profileId: swanIndexPosts.profileId,
            blogPostId: swanIndexPosts.blogPostId,
            organisationId: swanIndexPosts.organisationId,
            title: swanIndexPosts.title,
            dek: swanIndexPosts.dek,
            section: swanIndexPosts.section,
            sectionLabel: swanIndexSections.label,
            liveAt: swanIndexPosts.liveAt,
            robots: swanIndexPosts.robots,
            authorCanonicalUrl: swanIndexPosts.authorCanonicalUrl,
            publishedPayload: blogPosts.publishedPayload,
            sourceStatus: blogPosts.status,
            jobId: blogPosts.jobId,
            blueprintId: blogPosts.blueprintId,
            isAutonomous: blogPosts.isAutonomous,
            generationReason: blogPosts.generationReason,
        })
        .from(swanIndexPosts)
        .innerJoin(swanIndexProfiles, eq(swanIndexProfiles.id, swanIndexPosts.profileId))
        .innerJoin(blogPosts, eq(blogPosts.id, swanIndexPosts.blogPostId))
        .leftJoin(swanIndexSections, eq(swanIndexSections.key, swanIndexPosts.section))
        .where(and(
            sql`lower(${swanIndexProfiles.handle}) = ${handle.toLowerCase()}`,
            eq(swanIndexPosts.slug, slug),
            inArray(swanIndexPosts.status, [...PUBLIC_STATUSES]),
            eq(swanIndexProfiles.status, 'active'),
            eq(blogPosts.status, 'published'),
        ))
        .limit(1);
    if (!row) return null;
    const { profileId, ...rest } = row;
    return { row: rest as ArticleRow, profileId };
}

export interface AuthorListRow {
    handle: string; displayName: string; roleTitle: string | null; companyName: string | null;
    siteUrl: string | null; bio: string | null; pieces: number;
}

/** The contributors index — active profiles that have at least one piece on the site. */
export async function listAuthors(db: Db, limit = 200): Promise<AuthorListRow[]> {
    return db
        .select({
            handle: swanIndexProfiles.handle,
            displayName: swanIndexProfiles.displayName,
            roleTitle: swanIndexProfiles.roleTitle,
            companyName: swanIndexProfiles.companyName,
            siteUrl: swanIndexProfiles.siteUrl,
            bio: swanIndexProfiles.bio,
            pieces: sql<number>`count(${swanIndexPosts.id})::int`,
        })
        .from(swanIndexProfiles)
        .innerJoin(swanIndexPosts, and(
            eq(swanIndexPosts.profileId, swanIndexProfiles.id),
            inArray(swanIndexPosts.status, [...PUBLIC_STATUSES]),
        ))
        .where(eq(swanIndexProfiles.status, 'active'))
        .groupBy(
            swanIndexProfiles.handle, swanIndexProfiles.displayName, swanIndexProfiles.roleTitle,
            swanIndexProfiles.companyName, swanIndexProfiles.siteUrl, swanIndexProfiles.bio,
        )
        .orderBy(desc(sql`count(${swanIndexPosts.id})`))
        .limit(limit) as Promise<AuthorListRow[]>;
}

/**
 * Everything the sitemap may list.
 *
 * Only 'index,follow' rows. Submitting a noindex URL in a sitemap is a contradiction search engines
 * read as a configuration error, and since noindex is this publication's DEFAULT that would be
 * almost the entire file.
 */
export async function getIndexableUrls(db: Db, limit = 5000): Promise<Array<{ handle: string; slug: string; liveAt: Date | null }>> {
    return db
        .select({ handle: swanIndexProfiles.handle, slug: swanIndexPosts.slug, liveAt: swanIndexPosts.liveAt })
        .from(swanIndexPosts)
        .innerJoin(swanIndexProfiles, eq(swanIndexProfiles.id, swanIndexPosts.profileId))
        .innerJoin(blogPosts, eq(blogPosts.id, swanIndexPosts.blogPostId))
        .where(and(
            VISIBLE,
            eq(swanIndexPosts.robots, 'index,follow'),
            eq(blogPosts.status, 'published'),
            isNotNull(swanIndexPosts.liveAt),
        ))
        .orderBy(desc(swanIndexPosts.liveAt))
        .limit(limit);
}
