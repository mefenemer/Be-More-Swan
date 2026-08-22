// src/utils/blog-destinations/swanindex.ts
// The Swan Index adapter — destination #6, and the only FIRST-PARTY one.
//
// ── Why it is an adapter at all ────────────────────────────────────────────────────────────────
// Owning both ends means this could have been a direct write inside publishBlogPost(). It is an
// adapter because the dispatcher (syndicate.ts) already provides, for every destination:
//   · idempotent re-publish through the stored externalId (edit, never duplicate),
//   · the author's per-post opt-out via destinations.selected,
//   · the draft-vs-live publish mode,
//   · the mandatory EU AI Act Art. 50 disclosure appended to the body,
//   · failure isolation — one destination erroring never fails the publish or the others.
// A second write path would have to re-earn all five, and would drift from them the first time one
// changed. Being an adapter costs the two shims in store.ts and buys the lot.
//
// ── How it differs from the other five ─────────────────────────────────────────────────────────
// 1. No credentials. `authKind: 'firstparty'`; the "creds" are just the organisation id the
//    dispatcher is already acting for. store.ts synthesises them from the profile row.
// 2. It stores a REFERENCE, not a copy. `post.bodyMarkdown` is ignored entirely — the magazine
//    renders from blog_posts.published_payload at request time. See db/swan-index.sql.
//    A consequence worth stating: this is the one destination that carries the article's MEDIA,
//    because a same-infrastructure reader can re-resolve presigned URLs on every request.
// 3. It can refuse. The monthly cap is the publication's spam-farm control, and refusing is
//    reported through the normal error channel, so the author sees it in Blog Studio next to the
//    post rather than discovering it from a silently missing article.

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import { blogPosts, swanIndexPosts, swanIndexSections } from '../../../db/schema';
import type { BlogDestinationAdapter, SwanIndexCreds } from './types';
import { getProfileByOrg, checkAdmission } from '../swan-index/profile';
import { articlePath } from '../swan-index/render';
import { swanIndexBaseUrl } from '../swan-index/base-url';

/**
 * Tags that mean a section without containing its name.
 *
 * Key-substring matching alone almost never fired: an AI tags a piece "hiring", "cashflow" or
 * "pricing", and not one of those contains "people", "money" or "growth" — so nearly everything
 * arrived unsectioned and an editor placed it by hand. These are matched WHOLE, never as
 * substrings, because a wrong section is worse than none: it puts a piece in front of the wrong
 * readers under our masthead.
 *
 * The retired keys are aliases of their successors (capital → money, systems/craft → technology),
 * so a post tagged with the old vocabulary still lands somewhere sensible.
 */
export const SECTION_TAG_ALIASES: Record<string, string[]> = {
    operations: ['process', 'processes', 'workflow', 'workflows', 'delivery', 'logistics', 'admin',
        'efficiency', 'productivity', 'projectmanagement', 'outsourcing', 'suppliers', 'inventory'],
    growth: ['marketing', 'sales', 'pricing', 'demand', 'leads', 'leadgeneration', 'customers',
        'churn', 'retention', 'seo', 'advertising', 'socialmedia', 'branding', 'acquisition'],
    money: ['capital', 'cash', 'cashflow', 'finance', 'financial', 'funding', 'revenue', 'profit',
        'margins', 'tax', 'invoicing', 'budgeting', 'costs', 'accounting', 'investment'],
    people: ['hiring', 'recruitment', 'recruiting', 'staff', 'team', 'employees', 'management',
        'managing', 'onboarding', 'training', 'hr', 'performance', 'delegation'],
    technology: ['systems', 'craft', 'automation', 'ai', 'tools', 'tooling', 'software', 'tech',
        'integrations', 'data', 'security', 'saas', 'apps', 'product', 'design'],
    culture: ['values', 'leadership', 'communication', 'remote', 'remotework', 'hybrid',
        'workplace', 'diversity', 'inclusion', 'teamculture', 'purpose'],
    lifestyle: ['burnout', 'wellbeing', 'worklifebalance', 'health', 'habits', 'routine', 'mindset',
        'timemanagement', 'stress', 'founderlife', 'sleep', 'holiday'],
};

/**
 * Pick a section for a piece from its tags, or null to leave it unsectioned for an editor.
 *
 * A guess, and treated as one — `section` is an editorial field and the editor tools can overwrite
 * it. Sections are tried in the order given, which is the masthead's own order, so the earlier
 * (broader) section wins a tie rather than whichever the caller happened to list first.
 */
export function guessSection(tags: string[], sectionKeys: string[]): string | null {
    const norm = (tags || []).map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ''));
    for (const key of sectionKeys) {
        const k = key.replace(/[^a-z0-9]+/g, '');
        if (norm.some((t) => t === k || t.includes(k))) return key;
        const aliases = SECTION_TAG_ALIASES[key];
        if (aliases && norm.some((t) => aliases.includes(t))) return key;
    }
    return null;
}

/** The standfirst under a headline: the post's meta description, trimmed to a display length. */
export function toDek(metaDescription: string | null, max = 220): string | null {
    const s = (metaDescription || '').trim();
    if (!s) return null;
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, '')}…`;
}

export const swanindexAdapter: BlogDestinationAdapter<SwanIndexCreds> = {
    id: 'swanindex',
    label: 'The Swan Index',
    authKind: 'firstparty',
    credFields: [],
    // 'draft' lands the piece in the editor queue (status 'pending'); 'live' puts it straight on the
    // author's own profile page. Both are real states here, unlike the external platforms where a
    // draft is somebody else's dashboard.
    supportsDraft: true,

    parseCreds() {
        return { ok: false, error: 'The Swan Index needs no credentials — connect it from Blog Studio.' };
    },

    async validate(creds) {
        const db = getDb();
        const profile = await getProfileByOrg(db, creds.organisationId);
        if (!profile) return { ok: false, error: 'No Swan Index profile for this workspace.' };
        if (profile.status !== 'active') return { ok: false, error: `Profile is ${profile.status}.` };
        return { ok: true, accountLabel: `@${profile.handle}` };
    },

    async publish(post, creds, opts) {
        const db = getDb();
        const organisationId = creds.organisationId;

        const profile = await getProfileByOrg(db, organisationId);
        if (!profile) throw new Error('No Swan Index profile for this workspace.');

        // The dispatcher hands us the projected payload, which carries no ids — so the source row is
        // matched on the canonical URL the projection copied from it, falling back to the title.
        // Scoped to the org either way, so a match can only ever be this workspace's own post.
        //
        // TWO rows are fetched, not one, and that is the point. canonical_url is stamped by
        // publishBlogPost before syndication runs, so the fallback is rare — but an org CAN have two
        // published posts with the same title, and `.limit(1)` on the title path would silently pick
        // whichever the planner returned first. Syndicating the wrong article under an author's
        // byline is the single worst thing this adapter could do, so ambiguity is refused, not
        // resolved by guessing.
        const matched = await db
            .select({
                id: blogPosts.id,
                slug: blogPosts.slug,
                title: blogPosts.title,
                canonicalUrl: blogPosts.canonicalUrl,
                metaDescription: blogPosts.metaDescription,
                tags: blogPosts.tags,
                publishedAt: blogPosts.publishedAt,
            })
            .from(blogPosts)
            .where(and(
                eq(blogPosts.organisationId, organisationId),
                eq(blogPosts.status, 'published'),
                post.canonicalUrl
                    ? eq(blogPosts.canonicalUrl, post.canonicalUrl)
                    : eq(blogPosts.title, post.title),
            ))
            .limit(2);
        const source = matched[0];
        if (!source || !source.slug) {
            throw new Error('The Swan Index needs a published post with a slug.');
        }
        if (!post.canonicalUrl && matched.length > 1) {
            throw new Error(
                `Two published posts share the title "${post.title}" and neither carries a canonical URL, ` +
                'so the right one cannot be identified. Give one of them a distinct title and re-publish.',
            );
        }

        const [existing] = await db
            .select({ id: swanIndexPosts.id, status: swanIndexPosts.status, section: swanIndexPosts.section })
            .from(swanIndexPosts)
            .where(eq(swanIndexPosts.blogPostId, source.id))
            .limit(1);

        const admission = await checkAdmission(db, profile, { existing: !!existing });
        if (!admission.ok) throw new Error(admission.error || 'Not admitted.');

        const sections = await db.select({ key: swanIndexSections.key }).from(swanIndexSections)
            .where(eq(swanIndexSections.active, true));
        const tags = Array.isArray(source.tags) ? (source.tags as unknown[]).map(String) : [];

        const goLive = !opts?.asDraft;
        const now = new Date();
        // ── What a re-publish may and may not change ────────────────────────────────────────────
        // Nothing already published is demoted by the author saving an edit. A piece that is LIVE
        // stays live and a FEATURED piece stays featured, whatever the destination's draft/live
        // mode says — that mode decides where a piece ENTERS the publication, not what happens to
        // one already in it.
        //
        // Only 'featured' used to be protected, and the gap was doing real damage: the mode
        // defaults to 'draft' (the editorial queue), so an author adding an image to a live article
        // and re-publishing sent it back to 'pending' — off the public site until an editor
        // re-approved it — and the liveAt reset below wiped its original publication date too,
        // re-dating the piece and reshuffling every chronological list on the site. Both are
        // exactly what the comment two lines down says must not happen.
        //
        // 'rejected' and 'withdrawn' are editorial decisions and stay put. A first submission is
        // the only case the mode still governs.
        const nextStatus = existing?.status === 'featured' || existing?.status === 'live'
            ? existing.status
            : existing?.status === 'rejected' || existing?.status === 'withdrawn'
                ? existing.status
                : (goLive ? 'live' : 'pending');

        const shared = {
            profileId: profile.id,
            organisationId,
            slug: source.slug,
            title: source.title,
            dek: toDek(source.metaDescription),
            tags,
            // The author's own URL. Emitted as rel=canonical on the magazine page and named in
            // words in the provenance block — the promise the whole network rests on.
            authorCanonicalUrl: source.canonicalUrl ?? null,
            updatedAt: now,
        };

        let rowId: number;
        if (existing) {
            await db.update(swanIndexPosts)
                .set({
                    ...shared,
                    status: nextStatus,
                    // Keep the ORIGINAL live date across re-publishes; an edit is not a new piece,
                    // and re-dating it would reshuffle every chronological list on the site.
                    ...(nextStatus === 'live' || nextStatus === 'featured' ? {} : { liveAt: null }),
                    // Never overwrite a section an editor set by hand.
                    ...(existing.section ? {} : { section: guessSection(tags, sections.map((s) => s.key)) }),
                })
                .where(eq(swanIndexPosts.id, existing.id));
            rowId = existing.id;
        } else {
            const [created] = await db.insert(swanIndexPosts).values({
                ...shared,
                blogPostId: source.id,
                status: nextStatus,
                section: guessSection(tags, sections.map((s) => s.key)),
                liveAt: nextStatus === 'live' ? (source.publishedAt || now) : null,
                submittedAt: now,
            }).returning({ id: swanIndexPosts.id });
            rowId = created.id;
        }

        // Backfill liveAt the first time an update takes a pending piece live.
        if ((nextStatus === 'live' || nextStatus === 'featured')) {
            await db.update(swanIndexPosts)
                .set({ liveAt: source.publishedAt || now })
                .where(and(eq(swanIndexPosts.id, rowId), isNull(swanIndexPosts.liveAt)));
        }

        return {
            externalId: String(rowId),
            url: `${swanIndexBaseUrl()}${articlePath(profile.handle, source.slug)}`,
            status: nextStatus === 'pending' ? 'draft' : 'published',
        };
    },
};
